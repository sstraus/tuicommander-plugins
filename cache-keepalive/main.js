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
    /** Epoch ms when the last keepalive message was sent — used to find the matching JSONL response */
    this.lastKeepaliveSentAt = 0;
    /** True when we're waiting to read the real user follow-up turn from JSONL */
    this.pendingFollowUpVerify = false;
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
    /** Keepalives in chains where session closed without user return — pure cost */
    this.lostKeepalives = 0;
    /** Sum of cacheRead tokens from helpful keepalives only — basis for realistic savings */
    this.helpfulCacheReadTokens = 0;
    /** Sum of cacheRead tokens from lost chains — pure cost to subtract */
    this.lostCacheReadTokens = 0;
    /** Times we confirmed the user's real follow-up turn had a cache hit (true saving) */
    this.followUpHits = 0;
    /** Times the user's real follow-up turn had a cache miss (keepalive didn't help) */
    this.followUpMisses = 0;
    this.history = [];
  }

  /**
   * Called when a keepalive chain ends.
   * @param {"helpful"|"wasted"|"lost"} kind
   */
  finalizeChain(kind, keepaliveCount, chainCacheReadTokens) {
    if (kind === "helpful") {
      this.helpfulKeepalives += keepaliveCount;
      this.helpfulCacheReadTokens += chainCacheReadTokens;
    } else if (kind === "wasted") {
      this.wastedKeepalives += keepaliveCount;
    } else {
      // lost: session closed before user returned
      this.lostKeepalives += keepaliveCount;
      this.lostCacheReadTokens += chainCacheReadTokens;
    }
  }

  recordFollowUp(result) {
    if (result === "hit") this.followUpHits++;
    else this.followUpMisses++;
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
    // Cost of lost chains: we paid for keepalives in sessions that never returned.
    const lostCost =
      (this.lostCacheReadTokens / 1_000_000) * PRICING.cacheReadPerM;
    // Unconditional keepalive overhead: new input + output tokens on every ping.
    const keepaliveCost =
      (this.totalCacheReadTokens / 1_000_000) * PRICING.cacheReadPerM +
      (this.totalInputTokens / 1_000_000) * PRICING.inputPerM +
      (this.totalOutputTokens / 1_000_000) * PRICING.outputPerM;
    return {
      saved: Math.max(0, savedInput),
      realisticSaved: Math.max(0, realisticSaved),
      cost: keepaliveCost,
      lostCost,
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
      lostKeepalives: this.lostKeepalives,
      helpfulCacheReadTokens: this.helpfulCacheReadTokens,
      lostCacheReadTokens: this.lostCacheReadTokens,
      followUpHits: this.followUpHits,
      followUpMisses: this.followUpMisses,
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
      pluginId: PLUGIN_ID,
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
  const { realisticSaved, cost, lostCost } = stats.savings;
  // Net: realistic savings minus ALL costs (keepalive overhead + lost chains)
  const net = realisticSaved - cost - lostCost;
  const hitRate =
    stats.totalSent > 0
      ? Math.round((stats.totalHit / stats.totalSent) * 100)
      : 0;

  let subtitle = `${stats.totalSent} sent`;
  if (stats.totalHit > 0 || stats.totalMiss > 0) {
    subtitle += `, ${hitRate}% hit`;
  }
  if (stats.lostKeepalives > 0) {
    subtitle += `, ${stats.lostKeepalives} lost`;
  }
  if (Math.abs(net) > 0.005) {
    subtitle += ` — ${net >= 0 ? fmtDollars(net) + " saved" : "-" + fmtDollars(-net) + " net cost"}`;
  }

  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle });
}

// ── JSONL reading ────────────────────────────────────────────────────

/**
 * Read the assistant entry from JSONL that corresponds to a specific turn.
 *
 * Strategy: scan the 3 most-recently-modified JSONL files and find the
 * assistant entry whose timestamp is >= sentAtMs and closest to it (i.e.
 * the first assistant reply AFTER the keepalive was sent). This avoids
 * accidentally picking an unrelated conversation's last entry.
 *
 * @param {string} sessionId
 * @param {string} repoPath
 * @param {number} sentAtMs  - epoch ms when the keepalive message was sent
 * @param {boolean} [isFollowUp] - if true, we're verifying the real user turn
 * @returns {Promise<{result: "hit"|"miss"|"unknown", tokens: object|null}>}
 */
async function readJSONLAfter(sessionId, repoPath, sentAtMs, isFollowUp = false) {
  if (!hostRef || !repoPath) return { result: "unknown", tokens: null };

  try {
    const projectDir = await hostRef.getClaudeProjectDir(repoPath);
    if (!projectDir) return { result: "unknown", tokens: null };

    // Sort by mtime: active session file has the most recent write.
    const files = await hostRef.listDirectory(projectDir, "*.jsonl", { sortBy: "mtime" });
    if (!files || files.length === 0) {
      hostRef.log("warn", `No JSONL files in ${projectDir}`);
      return { result: "unknown", tokens: null };
    }

    // Check the 3 most recently modified files — the active session is among them.
    // We want the assistant entry with the smallest timestamp >= sentAtMs.
    let bestTokens = null;
    let bestTs = Infinity;

    const filesToCheck = files.slice(0, 3);
    for (const filename of filesToCheck) {
      try {
        const filePath = `${projectDir}/${filename}`;
        // Read a larger tail to make sure we have enough history to find the entry.
        const tail = await hostRef.readFileTail(filePath, 16384);
        if (!tail) continue;

        const lines = tail.split("\n").filter((l) => l.trim());
        for (let i = 0; i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== "assistant") continue;
            const usage = entry.message?.usage;
            if (!usage) continue;

            const ts = new Date(entry.timestamp ?? 0).getTime();
            // We want the first assistant entry that came AFTER the send time.
            // Allow a 2s window before sentAtMs to tolerate clock skew.
            if (ts >= sentAtMs - 2000 && ts < bestTs) {
              bestTs = ts;
              bestTokens = {
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheCreation: usage.cache_creation_input_tokens ?? 0,
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
              };
            }
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
      const label = isFollowUp ? "follow-up" : "keepalive";
      hostRef.log("info", `No JSONL entry after sentAt+${Math.round((Date.now() - sentAtMs) / 1000)}s for ${label} → unknown`);
      return { result: "unknown", tokens: null };
    }

    const result = bestTokens.cacheRead > bestTokens.cacheCreation ? "hit" : "miss";
    return { result, tokens: bestTokens };
  } catch (err) {
    hostRef.log("warn", `JSONL read failed for ${repoPath}: ${err}`);
    return { result: "unknown", tokens: null };
  }
}

/**
 * After keepalive response completes, verify cache hit/miss from JSONL.
 * Uses the send timestamp to find the matching response, not "last entry".
 */
async function verifyFromJSONL(sessionId, repoPath, sentAtMs) {
  if (!sessions.has(sessionId)) {
    stats.record(sessionId, "unknown", null);
    saveStats();
    updateDashboard();
    return;
  }

  const { result, tokens } = await readJSONLAfter(sessionId, repoPath, sentAtMs, false);

  if (result === "unknown" || !tokens) {
    stats.record(sessionId, "unknown", null);
  } else {
    stats.record(sessionId, result, tokens);

    const session = sessions.get(sessionId);
    if (session) {
      session.chainCacheReadTokens += tokens.cacheRead ?? 0;
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
      `Cache ${label}: read=${fmtTokens(tokens.cacheRead)} creation=${fmtTokens(tokens.cacheCreation)} → ${sessionId.slice(0, 8)}`
    );
    hostRef.setTicker({
      id: `${PLUGIN_ID}:status`,
      text: `Cache ${label} (${fmtTokens(tokens.cacheRead)} read)`,
      label: "Cache",
      icon: ICON,
      priority: result === "hit" ? 5 : 50,
      ttlMs: 10000,
    });
  }

  saveStats();
  updateDashboard();
}

/**
 * After the user's real follow-up turn completes, verify if the cache was warm.
 * This is the true savings signal: did the keepalive chain actually prevent a miss?
 *
 * @param {string} sessionId
 * @param {string} repoPath
 * @param {number} busyStartMs - when the user's real turn started (lastBusyAt)
 */
async function verifyFollowUp(sessionId, repoPath, busyStartMs) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pendingFollowUpVerify = false;

  const { result, tokens } = await readJSONLAfter(sessionId, repoPath, busyStartMs, true);

  if (result === "unknown") {
    hostRef?.log("info", `Follow-up verify: no JSONL entry found → ${sessionId.slice(0, 8)}`);
    return;
  }

  stats.recordFollowUp(result);
  const label = result === "hit" ? "HIT" : "MISS";
  hostRef?.log(
    "info",
    `Follow-up ${label}: read=${fmtTokens(tokens?.cacheRead)} → ${sessionId.slice(0, 8)} (keepalives were ${result === "hit" ? "EFFECTIVE" : "INEFFECTIVE"})`
  );
  hostRef?.setTicker({
    id: `${PLUGIN_ID}:followup`,
    text: `Return ${label} — keepalive ${result === "hit" ? "worked" : "failed"}`,
    label: "Cache",
    icon: ICON,
    priority: result === "hit" ? 3 : 60,
    ttlMs: 12000,
  });

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
        const sentAt = session.lastKeepaliveSentAt || session.pendingKeepaliveAt;
        session.pendingKeepalive = false;
        session.pendingKeepaliveAt = 0;
        // Still try to verify — the response may have arrived even if the idle event didn't
        verifyFromJSONL(sessionId, session.repoPath, sentAt);
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

      session.lastKeepaliveSentAt = now;
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
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "config.json" })
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
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "stats.json" })
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
        const { saved, realisticSaved, cost, lostCost } = stats.savings;
        const net = saved - cost - lostCost;
        const realisticNet = realisticSaved - cost - lostCost;
        const hitRate =
          stats.totalSent > 0
            ? Math.round((stats.totalHit / stats.totalSent) * 100)
            : 0;
        const followUpTotal = stats.followUpHits + stats.followUpMisses;
        const followUpHitRate = followUpTotal > 0
          ? Math.round((stats.followUpHits / followUpTotal) * 100) : null;

        let md = "# Cache Keepalive Analytics\n\n";

        md += "## Net Savings (Opus pricing)\n\n";
        md += "| Metric | Optimistic | Realistic |\n|--------|-----------|----------|\n";
        md += `| Avoided miss savings | ${fmtDollars(saved)} | ${fmtDollars(realisticSaved)} |\n`;
        md += `| Keepalive overhead | -${fmtDollars(cost)} | -${fmtDollars(cost)} |\n`;
        md += `| Lost chain cost | -${fmtDollars(lostCost)} | -${fmtDollars(lostCost)} |\n`;
        md += `| **Net** | **${net >= 0 ? fmtDollars(net) : "-" + fmtDollars(-net)}** | **${realisticNet >= 0 ? fmtDollars(realisticNet) : "-" + fmtDollars(-realisticNet)}** |\n\n`;
        md += "*Optimistic: every keepalive prevented a miss. Realistic: only chains where user returned AFTER cache TTL. Lost: sessions closed without return — pure cost.*\n\n";

        if (followUpTotal > 0) {
          md += "## Follow-Up Verification (ground truth)\n\n";
          md += "After each helpful chain, the user's real next turn is checked from JSONL.\n\n";
          md += "| Metric | Value |\n|--------|-------|\n";
          md += `| Follow-up cache hits | ${stats.followUpHits} |\n`;
          md += `| Follow-up cache misses | ${stats.followUpMisses} |\n`;
          md += `| **Effective rate** | **${followUpHitRate}%** |\n\n`;
        }

        md += "## Chain Breakdown\n\n";
        const chainTotal = stats.helpfulKeepalives + stats.wastedKeepalives + stats.lostKeepalives;
        const helpfulPct = chainTotal > 0 ? Math.round((stats.helpfulKeepalives / chainTotal) * 100) : 0;
        const lostPct = chainTotal > 0 ? Math.round((stats.lostKeepalives / chainTotal) * 100) : 0;
        md += "| Category | Keepalives | % |\n|----------|-----------|---|\n";
        md += `| Helpful (user returned after TTL) | ${stats.helpfulKeepalives} | ${helpfulPct}% |\n`;
        md += `| Wasted (user returned within TTL) | ${stats.wastedKeepalives} | ${chainTotal > 0 ? Math.round((stats.wastedKeepalives / chainTotal) * 100) : 0}% |\n`;
        md += `| **Lost (session closed, no return)** | **${stats.lostKeepalives}** | **${lostPct}%** |\n\n`;

        md += "## Token Breakdown\n\n";
        md += "| Metric | Tokens |\n|--------|--------|\n";
        md += `| Cache read (warm hits) | ${fmtTokens(stats.totalCacheReadTokens)} |\n`;
        md += `| Cache read from lost chains | ${fmtTokens(stats.lostCacheReadTokens)} |\n`;
        md += `| Cache creation (cold misses) | ${fmtTokens(stats.totalCacheCreationTokens)} |\n`;
        md += `| Input (new tokens per ping) | ${fmtTokens(stats.totalInputTokens)} |\n`;
        md += `| Output (ping responses) | ${fmtTokens(stats.totalOutputTokens)} |\n`;

        md += "\n## Ping Effectiveness\n\n";
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
        md += "Keepalive responses matched by send timestamp. Follow-up verification reads the user's real next turn.*\n";

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
          // Idle after our keepalive response — verify using send timestamp and reset timer
          const sentAt = session.lastKeepaliveSentAt || session.pendingKeepaliveAt;
          session.pendingKeepalive = false;
          session.pendingKeepaliveAt = 0;
          session.lastIdleAt = Date.now();
          // Delay slightly to let Claude Code finish writing the JSONL entry
          setTimeout(() => verifyFromJSONL(sessionId, session.repoPath, sentAt), 2000);
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
              const kind = elapsedSinceIdle > config.ttlMs ? "helpful" : "wasted";
              stats.finalizeChain(kind, session.keepaliveCount, session.chainCacheReadTokens);
              hostRef.log(
                "info",
                `Chain finalized: ${kind.toUpperCase()} (${session.keepaliveCount} pings, idle ${Math.round(elapsedSinceIdle / 1000)}s) → ${sessionId.slice(0, 8)}`
              );
              // Schedule follow-up verification: read the user's real turn JSONL
              // after it completes to confirm whether the cache was actually warm.
              if (kind === "helpful" && !session.pendingFollowUpVerify) {
                session.pendingFollowUpVerify = true;
                const busyStartMs = session.lastBusyAt;
                // Wait for the turn to complete before reading JSONL
                setTimeout(() => verifyFollowUp(sessionId, session.repoPath, busyStartMs), 5000);
              }
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

    // Clean up tracking when a session is closed — finalize any open chain as "lost"
    host.registerStructuredEventHandler("session-closed", (_payload, sessionId) => {
      const s = sessions.get(sessionId);
      if (s) {
        if (s.chainStartedAt > 0 && s.keepaliveCount > 0) {
          stats.finalizeChain("lost", s.keepaliveCount, s.chainCacheReadTokens);
          host.log(
            "info",
            `Chain LOST (session closed, ${s.keepaliveCount} pings orphaned) → ${sessionId.slice(0, 8)}`
          );
          saveStats();
          updateDashboard();
        }
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
