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
  message: "[noop] reply .",
  maxConsecutiveMisses: 2,
};

// ── Per-session state ────────────────────────────────────────────────

/** Minimum busy duration (ms) to count as real activity vs tab-switch noise */
const MIN_BUSY_DURATION_MS = 3000;
/** If pendingKeepalive isn't cleared within this window, force-clear it.
 *  Prevents deadlock when shell-state events stop reaching the plugin
 *  (e.g. agentType detection glitch clears the type, pluginMatchesSession
 *  returns false, and the idle-after-keepalive event never arrives). */
const PENDING_TIMEOUT_MS = 60_000;

class SessionTracker {
  constructor() {
    this.lastIdleAt = 0;
    this.lastBusyAt = 0;
    this.keepaliveCount = 0;
    this.pendingKeepalive = false;
    this.pendingKeepaliveAt = 0;
    this.shellState = null;
    this.repoPath = null;
    /** Epoch ms when usage resets, null = not rate-limited */
    this.rateLimitedUntilMs = null;
    /** Consecutive cache misses in the current idle stretch — abort when it hits maxConsecutiveMisses */
    this.consecutiveMisses = 0;
    /** Epoch ms when the current keepalive chain started (first ping of the idle stretch) */
    this.chainStartedAt = 0;
    /** Sum of cacheRead tokens verified for keepalives in the current chain */
    this.chainCacheReadTokens = 0;
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
    /** Keepalives in chains where the user returned AFTER the cache TTL — these actually saved money */
    this.helpfulKeepalives = 0;
    /** Keepalives in chains where the user returned WITHIN the cache TTL — wasted, cache would have stayed warm */
    this.wastedKeepalives = 0;
    /** Sum of cacheRead tokens from helpful keepalives only — basis for realistic savings */
    this.helpfulCacheReadTokens = 0;
    this.history = [];
  }

  /** Called when a keepalive chain ends (real user return) — classify as helpful or wasted */
  finalizeChain(helpful, keepaliveCount, chainCacheReadTokens) {
    if (helpful) {
      this.helpfulKeepalives += keepaliveCount;
      this.helpfulCacheReadTokens += chainCacheReadTokens;
    } else {
      this.wastedKeepalives += keepaliveCount;
    }
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
    // Upper bound: assumes EVERY kept-warm cacheRead would have been a miss.
    const savedInput =
      (this.totalCacheReadTokens / 1_000_000) *
      (PRICING.inputPerM - PRICING.cacheReadPerM);
    // Realistic: only count cacheReads from chains where the user returned AFTER
    // the cache TTL — those are the keepalives that actually prevented a miss.
    const realisticSaved =
      (this.helpfulCacheReadTokens / 1_000_000) *
      (PRICING.inputPerM - PRICING.cacheReadPerM);
    // Cost is unconditional — every ping pays cache read + new input + output.
    const keepaliveCost =
      (this.totalCacheReadTokens / 1_000_000) * PRICING.cacheReadPerM +
      (this.totalInputTokens / 1_000_000) * PRICING.inputPerM +
      (this.totalOutputTokens / 1_000_000) * PRICING.outputPerM;
    return {
      saved: Math.max(0, savedInput),
      realisticSaved: Math.max(0, realisticSaved),
      cost: keepaliveCost,
    };
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
      helpfulKeepalives: this.helpfulKeepalives,
      wastedKeepalives: this.wastedKeepalives,
      helpfulCacheReadTokens: this.helpfulCacheReadTokens,
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
    .catch((err) => {
      hostRef?.log("warn", `Stats persist failed: ${err}`);
    });
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
  const { realisticSaved, cost } = stats.savings;
  const net = realisticSaved - cost;
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
 * After keepalive response completes, read the last assistant entry
 * from the most recently modified JSONL in the project directory.
 */
async function verifyFromJSONL(sessionId, repoPath) {
  if (!hostRef || !repoPath || !sessions.has(sessionId)) {
    stats.record(sessionId, "unknown", null);
    saveStats();
    updateDashboard();
    return;
  }

  try {
    const projectDir = await hostRef.getClaudeProjectDir(repoPath);
    if (!projectDir) {
      stats.record(sessionId, "unknown", null);
      saveStats();
      updateDashboard();
      return;
    }

    // List JSONL files sorted by modification time (newest first).
    // The active session file is the one Claude Code just wrote to during our keepalive,
    // so mtime sort puts it at index 0. Without mtime sort we'd be picking files
    // alphabetically among 100+ historical UUIDs — essentially random.
    const files = await hostRef.listDirectory(projectDir, "*.jsonl", { sortBy: "mtime" });
    if (!files || files.length === 0) {
      hostRef.log("warn", `No JSONL files in ${projectDir}`);
      stats.record(sessionId, "unknown", null);
      saveStats();
      updateDashboard();
      return;
    }

    let bestTokens = null;
    let bestTs = 0;

    // Check the 3 most recently modified files — one of them is the active session.
    const filesToCheck = files.slice(0, 3);
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
      } catch (err) {
        hostRef.log("warn", `JSONL read failed for ${filename}: ${err}`);
        continue;
      }
    }

    if (!bestTokens) {
      hostRef.log("info", `No assistant entry found in JSONL → unknown`);
      stats.record(sessionId, "unknown", null);
    } else {
      const result = bestTokens.cacheRead > bestTokens.cacheCreation ? "hit" : "miss";
      stats.record(sessionId, result, bestTokens);

      // Track consecutive misses — abort logic enforced in checkKeepalives()
      const session = sessions.get(sessionId);
      if (session) {
        session.chainCacheReadTokens += bestTokens.cacheRead ?? 0;
        if (result === "hit") {
          session.consecutiveMisses = 0;
        } else {
          session.consecutiveMisses++;
          if (session.consecutiveMisses === config.maxConsecutiveMisses) {
            hostRef.log("info", `${session.consecutiveMisses} consecutive misses → stopping keepalives for ${sessionId.slice(0, 8)}`);
          }
        }
      }

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
    hostRef.log("warn", `JSONL read failed for ${repoPath}: ${err}`);
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
    if (session.pendingKeepalive) {
      if (session.pendingKeepaliveAt > 0 && now - session.pendingKeepaliveAt > PENDING_TIMEOUT_MS) {
        hostRef.log("warn", `pendingKeepalive stuck for ${Math.round((now - session.pendingKeepaliveAt) / 1000)}s → force-clearing ${sessionId.slice(0, 8)}`);
        session.pendingKeepalive = false;
        session.pendingKeepaliveAt = 0;
        stats.record(sessionId, "unknown", null);
        saveStats();
        updateDashboard();
      }
      continue;
    }
    if (session.rateLimitedUntilMs !== null && now < session.rateLimitedUntilMs) continue;
    if (session.consecutiveMisses >= config.maxConsecutiveMisses) continue;

    const idleMs = now - session.lastIdleAt;
    if (idleMs >= interval) {
      session.pendingKeepalive = true;
      session.pendingKeepaliveAt = now;
      session.keepaliveCount++;
      if (session.chainStartedAt === 0) {
        session.chainStartedAt = session.lastIdleAt;
        session.chainCacheReadTokens = 0;
      }
      activeCount++;

      // Resolve repo path for JSONL lookup
      if (!session.repoPath) {
        session.repoPath = hostRef.getRepoPathForSession(sessionId);
      }

      const count = session.keepaliveCount;
      const max = config.maxKeepalives;

      hostRef.sendAgentInput(sessionId, config.message).catch((err) => {
          const msg = String(err);
          if (msg.includes("not found") || msg.includes("No such session")) {
            hostRef.log("info", `Session ${sessionId.slice(0, 8)} closed — removing from tracking`);
            sessions.delete(sessionId);
          } else {
            hostRef.log("error", `Keepalive failed: ${err}`);
            session.pendingKeepalive = false;
            session.pendingKeepaliveAt = 0;
            session.keepaliveCount--;
          }
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

    // ── Load persisted data ──────────────────────────────────────
    host
      .invoke("read_plugin_data", { plugin_id: PLUGIN_ID, path: "config.json" })
      .then((raw) => {
        try {
          config = { ...DEFAULTS, ...JSON.parse(raw) };
          host.log("info", `Config: max=${config.maxKeepalives}, ttl=${config.ttlMs / 1000}s`);
        } catch (parseErr) {
          host.log("warn", `Config parse failed (using defaults): ${parseErr}`);
        }
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

    host.registerDashboard({
      label: "Keepalive Stats",
      icon: ICON,
      open: () => host.openMarkdownPanel("Cache Keepalive", `${PLUGIN_ID}:stats`),
    });

    host.registerMarkdownProvider(PLUGIN_ID, {
      provideContent() {
        const { saved, realisticSaved, cost } = stats.savings;
        const net = saved - cost;
        const realisticNet = realisticSaved - cost;
        const hitRate =
          stats.totalSent > 0
            ? Math.round((stats.totalHit / stats.totalSent) * 100)
            : 0;

        let md = "# Cache Keepalive Analytics\n\n";

        md += "## Cost Impact (Opus pricing)\n\n";
        md += "| Metric | Optimistic | Realistic |\n|--------|-----------|----------|\n";
        md += `| Avoided cache miss savings | ${fmtDollars(saved)} | ${fmtDollars(realisticSaved)} |\n`;
        md += `| Keepalive cost | ${fmtDollars(cost)} | ${fmtDollars(cost)} |\n`;
        md += `| **Net savings** | **${fmtDollars(net)}** | **${fmtDollars(realisticNet)}** |\n\n`;
        md += "*Optimistic assumes every keepalive prevented a miss. Realistic only counts chains where the user returned AFTER the cache TTL — chains resolved within the TTL are classified as wasted (cache would have stayed warm without our pings).*\n\n";

        md += "## Chain Effectiveness\n\n";
        const chainTotal = stats.helpfulKeepalives + stats.wastedKeepalives;
        const helpfulPct = chainTotal > 0 ? Math.round((stats.helpfulKeepalives / chainTotal) * 100) : 0;
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Helpful keepalives (user returned after TTL) | ${stats.helpfulKeepalives} |\n`;
        md += `| Wasted keepalives (user returned within TTL) | ${stats.wastedKeepalives} |\n`;
        md += `| **Helpful rate** | **${helpfulPct}%** |\n\n`;

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

    // ── Agent lifecycle — initialize tracking when agent is detected ──
    host.onStateChange((event) => {
      if (event.type === "agent-started" && event.sessionId) {
        const session = getSession(event.sessionId);
        if (session.lastIdleAt === 0) {
          session.lastIdleAt = Date.now();
        }
        host.log("info", `Agent started in ${event.sessionId.slice(0, 8)} — tracking`);
      }
      if (event.type === "agent-stopped" && event.sessionId) {
        sessions.delete(event.sessionId);
        host.log("info", `Agent stopped in ${event.sessionId.slice(0, 8)} — removed`);
      }
    });

    // ── Shell state tracking ─────────────────────────────────────
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = getSession(sessionId);
      const prev = session.shellState;
      session.shellState = payload.state;

      if (payload.state === "busy") {
        session.lastBusyAt = Date.now();
        // User manually resumed — clear rate limit state
        if (session.rateLimitedUntilMs !== null) {
          session.rateLimitedUntilMs = null;
          host.log("info", `Rate limit cleared (user resumed) → ${sessionId.slice(0, 8)}`);
          host.clearTicker(`${PLUGIN_ID}:status`);
        }
        return;
      }

      if (payload.state === "idle") {
        if (session.pendingKeepalive) {
          // Idle after our keepalive response — verify and reset timer
          session.pendingKeepalive = false;
          session.pendingKeepaliveAt = 0;
          session.lastIdleAt = Date.now();
          setTimeout(() => verifyFromJSONL(sessionId, session.repoPath), 2000);
          return;
        }

        if (prev === "busy") {
          // Only treat as real activity if busy for > MIN_BUSY_DURATION_MS.
          // Short busy blips (< 3s) are tab-switch or state-sync artifacts.
          const busyDuration = session.lastBusyAt
            ? Date.now() - session.lastBusyAt
            : 0;
          if (busyDuration >= MIN_BUSY_DURATION_MS) {
            // Real user activity — finalize the chain for realistic-savings tracking.
            // A chain is "helpful" if the user came back AFTER the cache TTL,
            // meaning without keepalives the next turn would have been a miss.
            if (session.chainStartedAt > 0 && session.keepaliveCount > 0) {
              const elapsedSinceIdle = Date.now() - session.chainStartedAt;
              const helpful = elapsedSinceIdle > config.ttlMs;
              stats.finalizeChain(helpful, session.keepaliveCount, session.chainCacheReadTokens);
              hostRef.log(
                "info",
                `Chain finalized: ${helpful ? "HELPFUL" : "WASTED"} (${session.keepaliveCount} pings, idle ${Math.round(elapsedSinceIdle / 1000)}s) → ${sessionId.slice(0, 8)}`
              );
              saveStats();
              updateDashboard();
            }
            session.keepaliveCount = 0;
            session.consecutiveMisses = 0;
            session.chainStartedAt = 0;
            session.chainCacheReadTokens = 0;
            session.lastIdleAt = Date.now();
          }
          // Short busy: don't touch lastIdleAt or count — timer continues
          return;
        }

        // prev was null (first time seeing session) or already idle (re-sync):
        // set lastIdleAt only if not already tracking
        if (session.lastIdleAt === 0) {
          session.lastIdleAt = Date.now();
        }
      }
    });

    // ── Usage exhaustion — stop keepalives, schedule auto-resume ───
    host.registerStructuredEventHandler("usage-exhausted", (payload, sessionId) => {
      const session = getSession(sessionId);
      session.pendingKeepalive = false;

      // Parse reset_time to a rough epoch if possible.
      // The Rust side passes the raw string (e.g. "8pm (Europe/Madrid)").
      // We don't parse timezones — just note the state and let the user resume.
      session.rateLimitedUntilMs = Date.now() + 60 * 60 * 1000; // default 1h

      // Stop further keepalives by maxing out the counter
      session.keepaliveCount = config.maxKeepalives;

      host.log("warn", `Usage exhausted → ${sessionId.slice(0, 8)} — keepalives paused, reset_time="${payload.reset_time ?? "unknown"}"`);
      host.setTicker({
        id: `${PLUGIN_ID}:status`,
        text: `Rate limited — resets ${payload.reset_time ?? "unknown"}`,
        label: "Cache",
        icon: ICON,
        priority: 80,
        ttlMs: 0, // persistent until cleared
      });
    });

    // Clean up tracking when a session is closed
    host.registerStructuredEventHandler("session-closed", (_payload, sessionId) => {
      const s = sessions.get(sessionId);
      if (s) {
        host.log("info", `Session ${sessionId.slice(0, 8)} closed — removing from tracking`);
        sessions.delete(sessionId);
      }
    });

    // Start periodic check
    checkTimer = setInterval(checkKeepalives, config.checkIntervalMs);
    host.log("info", "Active");
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
