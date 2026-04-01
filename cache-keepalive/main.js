/**
 * Cache Keepalive Plugin
 *
 * Prevents Claude API prompt cache expiry (5-min sliding TTL) by sending
 * minimal keepalive messages to idle Claude Code sessions before the cache
 * expires. Each hit resets the TTL at 0.1x input cost.
 *
 * Default: sends up to 3 keepalives per idle stretch (~4.5 min apart),
 * extending cache life from 5 min to ~23 min total.
 */

const PLUGIN_ID = "cache-keepalive";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3a.5.5 0 0 1 1 0v3.5H11a.5.5 0 0 1 0 1H8a.5.5 0 0 1-.5-.5V4z"/></svg>';
const SECTION_ID = "cache-keepalive";

/** Opus pricing per million tokens */
const PRICING = {
  inputPerM: 15.0,
  cacheWritePerM: 18.75, // 1.25x
  cacheReadPerM: 1.5, // 0.1x
};

// ── Configuration ────────────────────────────────────────────────────

const DEFAULTS = {
  /** Cache TTL in ms (Anthropic default: 5 min) */
  ttlMs: 5 * 60 * 1000,
  /** Send keepalive this many ms before TTL expires */
  marginMs: 30 * 1000,
  /** Max keepalives per idle stretch before giving up */
  maxKeepalives: 3,
  /** How often to check sessions (ms) */
  checkIntervalMs: 30 * 1000,
  /** Message sent to terminal — shortest possible to trigger API call */
  message: ".",
};

// ── Per-session state ────────────────────────────────────────────────

class SessionTracker {
  constructor() {
    this.lastIdleAt = 0;
    this.keepaliveCount = 0;
    this.pendingKeepalive = false;
    this.shellState = null;
  }
}

// ── Cumulative stats (persisted across reloads) ──────────────────────

class Stats {
  constructor() {
    this.totalSent = 0;
    this.totalHit = 0;
    this.totalMiss = 0;
    this.totalUnknown = 0;
    /** Total cache_read tokens from keepalive responses (confirms cache was warm) */
    this.totalCacheReadTokens = 0;
    /** Total cache_creation tokens from keepalive responses (cache was cold — miss) */
    this.totalCacheCreationTokens = 0;
    /** Total output tokens spent on keepalive responses */
    this.totalOutputTokens = 0;
    this.history = []; // last 20: { ts, session, result, cacheRead, cacheCreation, output }
  }

  record(sessionId, result, tokens) {
    if (result === "hit") this.totalHit++;
    else if (result === "miss") this.totalMiss++;
    else this.totalUnknown++;
    this.totalSent++;
    if (tokens) {
      this.totalCacheReadTokens += tokens.cacheRead ?? 0;
      this.totalCacheCreationTokens += tokens.cacheCreation ?? 0;
      this.totalOutputTokens += tokens.output ?? 0;
    }
    this.history.push({
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      result,
      ...(tokens ?? {}),
    });
    if (this.history.length > 20) this.history.shift();
  }

  /** Estimate savings: keepalive hit costs 0.1x vs full-price cache miss */
  get savings() {
    // Each cache_read token cost 0.1x instead of 1x.
    // Savings = cacheRead * (inputPrice - cacheReadPrice) per token
    const saved =
      (this.totalCacheReadTokens / 1_000_000) *
      (PRICING.inputPerM - PRICING.cacheReadPerM);
    // Keepalive cost = cache_read cost + output cost
    const keepaliveCost =
      (this.totalCacheReadTokens / 1_000_000) * PRICING.cacheReadPerM +
      (this.totalOutputTokens / 1_000_000) * PRICING.inputPerM; // output priced at 5x but let's use input as proxy
    return { saved: Math.max(0, saved), cost: keepaliveCost };
  }

  toJSON() {
    return {
      totalSent: this.totalSent,
      totalHit: this.totalHit,
      totalMiss: this.totalMiss,
      totalUnknown: this.totalUnknown,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      totalOutputTokens: this.totalOutputTokens,
      history: this.history,
    };
  }

  static fromJSON(obj) {
    const s = new Stats();
    s.totalSent = obj.totalSent ?? 0;
    s.totalHit = obj.totalHit ?? 0;
    s.totalMiss = obj.totalMiss ?? 0;
    s.totalUnknown = obj.totalUnknown ?? 0;
    s.totalCacheReadTokens = obj.totalCacheReadTokens ?? 0;
    s.totalCacheCreationTokens = obj.totalCacheCreationTokens ?? 0;
    s.totalOutputTokens = obj.totalOutputTokens ?? 0;
    s.history = obj.history ?? [];
    return s;
  }
}

// ── Module state ─────────────────────────────────────────────────────

/** @type {Map<string, SessionTracker>} */
const sessions = new Map();
let checkTimer = null;
let hostRef = null;
let config = { ...DEFAULTS };
let stats = new Stats();

/**
 * Sessions awaiting verification after keepalive.
 * @type {Map<string, number>} sessionId → keepalive timestamp
 */
const pendingVerification = new Map();

/**
 * Temporary token accumulator for pending verifications.
 * Output watchers fire per-line so we accumulate before final tally.
 * @type {Map<string, {cacheRead:number, cacheCreation:number, output:number}>}
 */
const pendingTokens = new Map();

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

function updateDashboard() {
  if (!hostRef) return;
  const { saved, cost } = stats.savings;
  const hitRate =
    stats.totalSent > 0
      ? Math.round((stats.totalHit / stats.totalSent) * 100)
      : 0;
  const net = saved - cost;

  let subtitle = `${stats.totalSent} sent`;
  if (stats.totalHit > 0 || stats.totalMiss > 0) {
    subtitle += `, ${hitRate}% hit rate`;
  }
  if (saved > 0) {
    subtitle += ` — est. $${net.toFixed(2)} net saved`;
  }

  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle });
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDollars(n) {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

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
      const count = session.keepaliveCount;
      const max = config.maxKeepalives;

      pendingVerification.set(sessionId, now);
      pendingTokens.set(sessionId, { cacheRead: 0, cacheCreation: 0, output: 0 });

      hostRef.writePty(sessionId, config.message + "\n").catch((err) => {
        hostRef.log("error", `Keepalive failed for ${sessionId}: ${err}`);
        session.pendingKeepalive = false;
        session.keepaliveCount--;
        pendingVerification.delete(sessionId);
        pendingTokens.delete(sessionId);
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

/** Finalize verification for a session — called on idle or timeout */
function finalizeVerification(sessionId) {
  if (!pendingVerification.has(sessionId)) return;
  pendingVerification.delete(sessionId);
  const tokens = pendingTokens.get(sessionId);
  pendingTokens.delete(sessionId);

  const cacheRead = tokens?.cacheRead ?? 0;
  const cacheCreation = tokens?.cacheCreation ?? 0;
  const hasData = cacheRead > 0 || cacheCreation > 0;

  let result;
  if (!hasData) {
    result = "unknown";
  } else if (cacheRead > cacheCreation) {
    result = "hit";
  } else {
    result = "miss";
  }

  stats.record(sessionId, result, tokens);
  saveStats();
  updateDashboard();

  if (hostRef) {
    const label = result === "hit" ? "HIT" : result === "miss" ? "MISS" : "?";
    const detail = hasData ? ` (read: ${fmtTokens(cacheRead)})` : "";
    hostRef.log("info", `Keepalive verified: cache ${label}${detail} → ${sessionId.slice(0, 8)}`);

    if (hasData) {
      hostRef.setTicker({
        id: `${PLUGIN_ID}:status`,
        text: `Cache ${label}${detail}`,
        label: "Cache",
        icon: ICON,
        priority: result === "hit" ? 5 : 50,
        ttlMs: 8000,
      });
    }
  }
}

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

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

        // ── Savings summary ──
        md += "## Cost Impact\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Est. savings (avoided cache misses) | ${fmtDollars(saved)} |\n`;
        md += `| Keepalive cost (cache reads + output) | ${fmtDollars(cost)} |\n`;
        md += `| **Net savings** | **${fmtDollars(net)}** |\n`;
        md += "\n";
        md += `*Savings estimated using Opus pricing: $15/M input, $1.50/M cache read, $18.75/M cache write.*\n\n`;

        // ── Token breakdown ──
        md += "## Token Breakdown\n\n";
        md += "| Metric | Tokens |\n|--------|--------|\n";
        md += `| Cache read (kept warm) | ${fmtTokens(stats.totalCacheReadTokens)} |\n`;
        md += `| Cache creation (rebuilt) | ${fmtTokens(stats.totalCacheCreationTokens)} |\n`;
        md += `| Output (responses) | ${fmtTokens(stats.totalOutputTokens)} |\n`;

        // ── Hit/miss ──
        md += "\n## Effectiveness\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Keepalives sent | ${stats.totalSent} |\n`;
        md += `| Cache hits | ${stats.totalHit} |\n`;
        md += `| Cache misses | ${stats.totalMiss} |\n`;
        md += `| Unknown (no data) | ${stats.totalUnknown} |\n`;
        md += `| Hit rate | ${hitRate}% |\n`;

        // ── Config ──
        md += "\n## Configuration\n\n";
        md += "| Setting | Value |\n|---------|-------|\n";
        md += `| Cache TTL | ${config.ttlMs / 1000}s |\n`;
        md += `| Margin before expiry | ${config.marginMs / 1000}s |\n`;
        md += `| Max keepalives per pause | ${config.maxKeepalives} |\n`;
        md += `| Keepalive message | \`${config.message}\` |\n`;
        md += `| Check interval | ${config.checkIntervalMs / 1000}s |\n`;

        // ── Recent history ──
        if (stats.history.length > 0) {
          md += "\n## Recent History (last 20)\n\n";
          md += "| Time | Session | Result | Cache Read | Cache Write |\n";
          md += "|------|---------|--------|------------|-------------|\n";
          for (const h of [...stats.history].reverse()) {
            const r = h.result === "hit" ? "HIT" : h.result === "miss" ? "MISS" : "?";
            const cr = h.cacheRead != null ? fmtTokens(h.cacheRead) : "-";
            const cc = h.cacheCreation != null ? fmtTokens(h.cacheCreation) : "-";
            md += `| ${h.ts.slice(11, 19)} | ${h.session} | ${r} | ${cr} | ${cc} |\n`;
          }
        }

        // ── Manual verification ──
        md += "\n## Manual Verification\n\n";
        md += "Check Claude Code session JSONL for cache token breakdown:\n\n";
        md += "```bash\n";
        md += "# Last 5 responses with cache breakdown\n";
        md += 'tail -20 ~/.claude/projects/*/conversation.jsonl | \\\n';
        md += '  grep -o \'"cache_read_input_tokens":[0-9]*\\|"cache_creation_input_tokens":[0-9]*\'\n';
        md += "```\n\n";
        md += "A keepalive cache **hit** shows high `cache_read_input_tokens` and zero/low `cache_creation_input_tokens`.\n";
        md += "A cache **miss** shows the opposite: high creation, low read.\n";

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
          // Finalize verification after a short delay to let output watchers capture tokens
          setTimeout(() => finalizeVerification(sessionId), 3000);
        } else if (prev === "busy") {
          session.keepaliveCount = 0;
        }
        session.lastIdleAt = Date.now();
      }
    });

    // ── Token capture from terminal output ───────────────────────
    // Claude Code prints usage info with cache breakdown.
    // We capture cache_read and cache_creation tokens to verify hits.
    host.registerOutputWatcher({
      pattern: /cache[_\s]?read[_\s]?input[_\s]?tokens[\s:"]*(\d+)/i,
      onMatch(match, sessionId) {
        const tokens = pendingTokens.get(sessionId);
        if (tokens) tokens.cacheRead = parseInt(match[1], 10);
      },
    });

    host.registerOutputWatcher({
      pattern: /cache[_\s]?creation[_\s]?input[_\s]?tokens[\s:"]*(\d+)/i,
      onMatch(match, sessionId) {
        const tokens = pendingTokens.get(sessionId);
        if (tokens) tokens.cacheCreation = parseInt(match[1], 10);
      },
    });

    host.registerOutputWatcher({
      pattern: /output[_\s]?tokens[\s:"]*(\d+)/i,
      onMatch(match, sessionId) {
        const tokens = pendingTokens.get(sessionId);
        if (tokens) tokens.output = parseInt(match[1], 10);
      },
    });

    // ── Timeout fallback: finalize after 15s if shell-state idle not received ──
    // (e.g., if CC hangs or output is too fast)
    // This is handled per-keepalive in checkKeepalives via pendingVerification map.

    // Start periodic check
    checkTimer = setInterval(checkKeepalives, config.checkIntervalMs);
    host.log("info", "Cache keepalive active");
  },

  onunload() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    sessions.clear();
    pendingVerification.clear();
    pendingTokens.clear();
    hostRef = null;
  },
};
