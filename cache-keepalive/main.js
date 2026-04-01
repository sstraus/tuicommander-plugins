/**
 * Cache Keepalive Plugin
 *
 * Prevents Claude API prompt cache expiry (5-min sliding TTL) by sending
 * minimal keepalive messages to idle Claude Code sessions before the cache
 * expires. Each hit resets the TTL at 0.1x input cost.
 *
 * Default: sends up to 3 keepalives per idle stretch (~4.5 min apart),
 * extending cache life from 5 min to ~23 min total.
 *
 * Verification: after each keepalive, reads the Claude Code session JSONL
 * to confirm cache hit/miss from actual API token usage.
 */

const PLUGIN_ID = "cache-keepalive";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3a.5.5 0 0 1 1 0v3.5H11a.5.5 0 0 1 0 1H8a.5.5 0 0 1-.5-.5V4z"/></svg>';
const SECTION_ID = "cache-keepalive";

/** Claude Code stores sessions in ~/.claude/projects/<path-with-dashes>/<uuid>.jsonl */
const CLAUDE_PROJECTS_DIR = "~/.claude/projects";

/** Opus pricing per million tokens */
const PRICING = {
  inputPerM: 15.0,
  cacheWritePerM: 18.75, // 1.25x
  cacheReadPerM: 1.5, // 0.1x
  outputPerM: 75.0,
};

// ── Configuration ────────────────────────────────────────────────────

const DEFAULTS = {
  ttlMs: 5 * 60 * 1000,
  marginMs: 30 * 1000,
  maxKeepalives: 3,
  checkIntervalMs: 30 * 1000,
  message: ".",
};

// ── Per-session state ────────────────────────────────────────────────

class SessionTracker {
  constructor() {
    this.lastIdleAt = 0;
    this.keepaliveCount = 0;
    this.pendingKeepalive = false;
    this.shellState = null;
    this.repoPath = null;
  }
}

// ── Cumulative stats (persisted across reloads) ──────────────────────

class Stats {
  constructor() {
    this.totalSent = 0;
    this.totalHit = 0;
    this.totalMiss = 0;
    this.totalUnknown = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.history = [];
  }

  record(sessionId, result, tokens) {
    if (result === "hit") this.totalHit++;
    else if (result === "miss") this.totalMiss++;
    else this.totalUnknown++;
    this.totalSent++;
    if (tokens) {
      this.totalCacheReadTokens += tokens.cacheRead ?? 0;
      this.totalCacheCreationTokens += tokens.cacheCreation ?? 0;
      this.totalInputTokens += tokens.input ?? 0;
      this.totalOutputTokens += tokens.output ?? 0;
    }
    this.history.push({
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      result,
      ...(tokens ?? {}),
    });
    if (this.history.length > 50) this.history.shift();
  }

  get savings() {
    // Without keepalive, cache_read tokens would have been full-price input
    const savedInput =
      (this.totalCacheReadTokens / 1_000_000) *
      (PRICING.inputPerM - PRICING.cacheReadPerM);
    // Keepalive cost: cache read + new input + output
    const keepaliveCost =
      (this.totalCacheReadTokens / 1_000_000) * PRICING.cacheReadPerM +
      (this.totalInputTokens / 1_000_000) * PRICING.inputPerM +
      (this.totalOutputTokens / 1_000_000) * PRICING.outputPerM;
    return { saved: Math.max(0, savedInput), cost: keepaliveCost };
  }

  toJSON() {
    return {
      totalSent: this.totalSent,
      totalHit: this.totalHit,
      totalMiss: this.totalMiss,
      totalUnknown: this.totalUnknown,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      history: this.history,
    };
  }

  static fromJSON(obj) {
    const s = new Stats();
    Object.assign(s, obj);
    s.history = obj.history ?? [];
    return s;
  }
}

// ── Module state ─────────────────────────────────────────────────────

const sessions = new Map();
let checkTimer = null;
let hostRef = null;
let config = { ...DEFAULTS };
let stats = new Stats();
let homePath = null;

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = new SessionTracker();
    sessions.set(sessionId, s);
  }
  return s;
}

function saveStats() {
  if (!hostRef) return;
  hostRef
    .invoke("write_plugin_data", {
      plugin_id: PLUGIN_ID,
      path: "stats.json",
      content: JSON.stringify(stats.toJSON()),
    })
    .catch(() => {});
}

function fmtTokens(n) {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDollars(n) {
  if (n < 0.005 && n > 0) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function updateDashboard() {
  if (!hostRef) return;
  const { saved, cost } = stats.savings;
  const net = saved - cost;
  const hitRate =
    stats.totalSent > 0
      ? Math.round((stats.totalHit / stats.totalSent) * 100)
      : 0;

  let subtitle = `${stats.totalSent} sent`;
  if (stats.totalHit > 0 || stats.totalMiss > 0) {
    subtitle += `, ${hitRate}% hit`;
  }
  if (net > 0.005) {
    subtitle += ` — ${fmtDollars(net)} saved`;
  }

  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle });
}

// ── JSONL reading ────────────────────────────────────────────────────

/**
 * Derive Claude Code project directory from a repo path.
 * /Users/foo/bar → -Users-foo-bar
 */
function repoPathToClaudeDir(repoPath) {
  return repoPath.replace(/\//g, "-");
}

/**
 * After keepalive response completes, read the last assistant entry
 * from the most recently modified JSONL in the project directory.
 */
async function verifyFromJSONL(sessionId, repoPath) {
  if (!hostRef || !repoPath) {
    stats.record(sessionId, "unknown", null);
    saveStats();
    updateDashboard();
    return;
  }

  try {
    const claudeDir = repoPathToClaudeDir(repoPath);
    const projectDir = `${homePath}/.claude/projects/${claudeDir}`;

    // List JSONL files to find the most recent
    const files = await hostRef.listDirectory(projectDir, "*.jsonl");
    if (!files || files.length === 0) {
      hostRef.log("warn", `No JSONL files in ${projectDir}`);
      stats.record(sessionId, "unknown", null);
      saveStats();
      updateDashboard();
      return;
    }

    // Read tail of each file to find the most recently written one.
    // In practice, the active session's file is the most recent.
    // We try the last few files sorted alphabetically (UUIDs, so order ≈ random).
    // Better approach: read tail of ALL and pick the one with the latest timestamp.
    // For efficiency, just try each file's tail until we find an assistant entry.
    let bestTokens = null;
    let bestTs = 0;

    // Read at most 5 files (most should be stale)
    const filesToCheck = files.slice(-5);
    for (const filename of filesToCheck) {
      try {
        const filePath = `${projectDir}/${filename}`;
        const tail = await hostRef.readFileTail(filePath, 8192);
        if (!tail) continue;

        // Parse lines from the tail, find the last assistant entry
        const lines = tail.split("\n").filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== "assistant") continue;
            const usage = entry.message?.usage;
            if (!usage) continue;

            const ts = new Date(entry.timestamp ?? 0).getTime();
            if (ts > bestTs) {
              bestTs = ts;
              bestTokens = {
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheCreation: usage.cache_creation_input_tokens ?? 0,
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
              };
            }
            break; // Only need last assistant entry per file
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    if (!bestTokens) {
      hostRef.log("info", `No assistant entry found in JSONL → unknown`);
      stats.record(sessionId, "unknown", null);
    } else {
      const result = bestTokens.cacheRead > bestTokens.cacheCreation ? "hit" : "miss";
      stats.record(sessionId, result, bestTokens);

      const label = result === "hit" ? "HIT" : "MISS";
      hostRef.log(
        "info",
        `Cache ${label}: read=${fmtTokens(bestTokens.cacheRead)} creation=${fmtTokens(bestTokens.cacheCreation)} → ${sessionId.slice(0, 8)}`
      );
      hostRef.setTicker({
        id: `${PLUGIN_ID}:status`,
        text: `Cache ${label} (${fmtTokens(bestTokens.cacheRead)} read)`,
        label: "Cache",
        icon: ICON,
        priority: result === "hit" ? 5 : 50,
        ttlMs: 10000,
      });
    }
  } catch (err) {
    hostRef.log("warn", `JSONL read failed: ${err}`);
    stats.record(sessionId, "unknown", null);
  }

  saveStats();
  updateDashboard();
}

// ── Keepalive check ──────────────────────────────────────────────────

function checkKeepalives() {
  if (!hostRef) return;
  const now = Date.now();
  const interval = config.ttlMs - config.marginMs;
  let activeCount = 0;

  for (const [sessionId, session] of sessions) {
    if (session.shellState !== "idle") continue;
    if (session.keepaliveCount >= config.maxKeepalives) continue;
    if (session.lastIdleAt === 0) continue;
    if (session.pendingKeepalive) continue;

    const idleMs = now - session.lastIdleAt;
    if (idleMs >= interval) {
      session.pendingKeepalive = true;
      session.keepaliveCount++;
      activeCount++;

      // Resolve repo path for JSONL lookup
      if (!session.repoPath) {
        session.repoPath = hostRef.getRepoPathForSession(sessionId);
      }

      const count = session.keepaliveCount;
      const max = config.maxKeepalives;

      hostRef.writePty(sessionId, config.message + "\n").catch((err) => {
        hostRef.log("error", `Keepalive failed: ${err}`);
        session.pendingKeepalive = false;
        session.keepaliveCount--;
      });

      hostRef.log("info", `Keepalive ${count}/${max} → ${sessionId.slice(0, 8)}`);
      hostRef.setTicker({
        id: `${PLUGIN_ID}:status`,
        text: `Keepalive ${count}/${max}`,
        label: "Cache",
        icon: ICON,
        priority: 5,
        ttlMs: 15000,
      });
    } else if (session.keepaliveCount < config.maxKeepalives) {
      activeCount++;
    }
  }

  if (activeCount === 0) {
    hostRef.clearTicker(`${PLUGIN_ID}:status`);
  }
}

// ── Plugin lifecycle ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    // Resolve home path for JSONL access
    // Plugin API paths must be absolute, so we need $HOME
    try {
      const repo = host.getActiveRepo();
      if (repo?.path) {
        // Extract home from a known path like /Users/foo/Gits/...
        const match = repo.path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
        if (match) homePath = match[1];
      }
    } catch {}
    if (!homePath) {
      // Fallback: assume macOS default
      homePath = "/Users/" + (typeof process !== "undefined" ? process.env?.USER : "unknown");
    }

    // ── Load persisted data ──────────────────────────────────────
    host
      .invoke("read_plugin_data", { plugin_id: PLUGIN_ID, path: "config.json" })
      .then((raw) => {
        config = { ...DEFAULTS, ...JSON.parse(raw) };
        host.log("info", `Config: max=${config.maxKeepalives}, ttl=${config.ttlMs / 1000}s`);
      })
      .catch(() => {
        host.log("info", `Defaults: max=${config.maxKeepalives}, ttl=${config.ttlMs / 1000}s`);
      });

    host
      .invoke("read_plugin_data", { plugin_id: PLUGIN_ID, path: "stats.json" })
      .then((raw) => {
        stats = Stats.fromJSON(JSON.parse(raw));
        host.log("info", `Stats: ${stats.totalSent} sent, ${stats.totalHit} hits`);
        updateDashboard();
      })
      .catch(() => {});

    // ── Activity Center ──────────────────────────────────────────
    host.registerSection({
      id: SECTION_ID,
      label: "CACHE KEEPALIVE",
      priority: 60,
      canDismissAll: false,
    });

    host.addItem({
      id: `${PLUGIN_ID}:dashboard`,
      pluginId: PLUGIN_ID,
      sectionId: SECTION_ID,
      title: "Cache Keepalive Stats",
      subtitle: "No keepalives sent yet",
      icon: ICON,
      dismissible: false,
      contentUri: `${PLUGIN_ID}:stats`,
    });

    host.registerMarkdownProvider(PLUGIN_ID, {
      provideContent() {
        const { saved, cost } = stats.savings;
        const net = saved - cost;
        const hitRate =
          stats.totalSent > 0
            ? Math.round((stats.totalHit / stats.totalSent) * 100)
            : 0;

        let md = "# Cache Keepalive Analytics\n\n";

        md += "## Cost Impact (Opus pricing)\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Avoided cache miss savings | ${fmtDollars(saved)} |\n`;
        md += `| Keepalive cost | ${fmtDollars(cost)} |\n`;
        md += `| **Net savings** | **${fmtDollars(net)}** |\n\n`;
        md += "*Each keepalive hit pays 0.1x instead of the 1x that a cache miss would cost on the next real turn.*\n\n";

        md += "## Token Breakdown\n\n";
        md += "| Metric | Tokens |\n|--------|--------|\n";
        md += `| Cache read (warm) | ${fmtTokens(stats.totalCacheReadTokens)} |\n`;
        md += `| Cache creation (cold) | ${fmtTokens(stats.totalCacheCreationTokens)} |\n`;
        md += `| Input (new) | ${fmtTokens(stats.totalInputTokens)} |\n`;
        md += `| Output (responses) | ${fmtTokens(stats.totalOutputTokens)} |\n`;

        md += "\n## Effectiveness\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Keepalives sent | ${stats.totalSent} |\n`;
        md += `| Cache hits (read > creation) | ${stats.totalHit} |\n`;
        md += `| Cache misses | ${stats.totalMiss} |\n`;
        md += `| Unverified | ${stats.totalUnknown} |\n`;
        md += `| **Hit rate** | **${hitRate}%** |\n`;

        md += "\n## Configuration\n\n";
        md += "| Setting | Value |\n|---------|-------|\n";
        md += `| Cache TTL | ${config.ttlMs / 1000}s |\n`;
        md += `| Send margin | ${config.marginMs / 1000}s before expiry |\n`;
        md += `| Max per pause | ${config.maxKeepalives} |\n`;
        md += `| Message | \`${config.message}\` |\n`;

        if (stats.history.length > 0) {
          md += "\n## Recent History\n\n";
          md += "| Time | Session | Result | Cache Read | Cache Write | Output |\n";
          md += "|------|---------|--------|------------|-------------|--------|\n";
          for (const h of [...stats.history].reverse().slice(0, 20)) {
            const r = h.result === "hit" ? "HIT" : h.result === "miss" ? "MISS" : "?";
            md += `| ${h.ts.slice(11, 19)} | ${h.session} | ${r} | ${fmtTokens(h.cacheRead)} | ${fmtTokens(h.cacheCreation)} | ${fmtTokens(h.output)} |\n`;
          }
        }

        md += "\n---\n*Data source: Claude Code session JSONL (`~/.claude/projects/`). ";
        md += "Verification reads `message.usage.cache_read_input_tokens` from the last assistant entry.*\n";

        return md;
      },
    });

    // ── Shell state tracking ─────────────────────────────────────
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = getSession(sessionId);
      const prev = session.shellState;
      session.shellState = payload.state;

      if (payload.state === "idle") {
        if (session.pendingKeepalive) {
          session.pendingKeepalive = false;
          // Wait a moment for CC to flush JSONL, then verify
          setTimeout(() => verifyFromJSONL(sessionId, session.repoPath), 2000);
        } else if (prev === "busy") {
          session.keepaliveCount = 0;
        }
        session.lastIdleAt = Date.now();
      }
    });

    // Start periodic check
    checkTimer = setInterval(checkKeepalives, config.checkIntervalMs);
    host.log("info", `Active — home=${homePath}`);
  },

  onunload() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    sessions.clear();
    hostRef = null;
  },
};
