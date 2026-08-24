/**
 * At-Capacity Retry Plugin
 *
 * Codex fails a turn with:
 *
 *   ⚠ Selected model is at capacity. Please try a different model.
 *
 * The turn is lost, but the model is usually available again after a short
 * pause. This plugin detects the message, waits 1 minute, then sends
 * `retry last request` to the agent.
 *
 * Circuit breaker: more than 3 retries in one rolling hour means the capacity
 * problem is not transient. The plugin then blocks for that session — it stops
 * all retries, pins a ticker and plays a sound. Real user input in the session
 * unblocks it (the human took over) and clears the hour budget.
 *
 * Repaint safety: a TUI redraws its scrollback, so the same warning line
 * reaches the output watcher many times. Two guards keep one incident from
 * counting as many: a scheduled retry absorbs all further detections, and a
 * detection debounce ignores repeats that follow too closely.
 */

const PLUGIN_ID = "at-capacity-retry";
const SECTION_ID = "at-capacity-retry";

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .655-.835ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>';

/**
 * The warning wraps at narrow terminal widths, so each half is matched on its
 * own. A duplicate hit from a wrapped line costs nothing — the debounce and the
 * pending-retry guard collapse it into one incident.
 */
const CAPACITY_RE =
  /(?:model is at capacity|at capacity\.\s*please try a different model)/i;

const DEFAULTS = {
  /** Wait before the retry is sent. */
  retryDelayMs: 60 * 1000,
  /** Retries allowed inside `windowMs` before the breaker trips. */
  maxRetriesPerWindow: 3,
  /** Rolling window of the breaker. */
  windowMs: 60 * 60 * 1000,
  /** Text sent to the agent. */
  retryText: "retry last request",
  /** Repeat detections inside this window belong to the same incident. */
  detectDebounceMs: 20 * 1000,
  /** Ticker countdown refresh. */
  tickerIntervalMs: 5 * 1000,
};

// ── Per-session state ────────────────────────────────────────────────

class SessionState {
  constructor() {
    /** setTimeout handle of the pending retry, null when none is pending. */
    this.timer = null;
    /** Wall-clock time the pending retry must fire at. */
    this.dueAt = 0;
    /** Last accepted detection, for the repaint debounce. */
    this.lastDetectAt = 0;
    /** Detection that the pending retry belongs to. */
    this.detectedAt = 0;
    /** Last busy transition, to tell a self-restarted agent from a stale state. */
    this.lastBusyAt = 0;
    /** Wall-clock times of the retries sent inside the rolling window. */
    this.retryTimes = [];
    this.blocked = false;
    this.blockedAt = 0;
    this.shellState = null;
  }
}

class Stats {
  constructor() {
    this.incidents = 0;
    this.retriesSent = 0;
    this.retriesSkipped = 0;
    this.breakerTrips = 0;
    this.history = [];
  }

  record(sessionId, event, detail) {
    this.history.push({
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      event,
      detail: detail ?? "",
    });
    if (this.history.length > 50) this.history.shift();
  }

  toJSON() {
    return {
      incidents: this.incidents,
      retriesSent: this.retriesSent,
      retriesSkipped: this.retriesSkipped,
      breakerTrips: this.breakerTrips,
      history: this.history,
    };
  }

  static fromJSON(obj) {
    const s = new Stats();
    if (!obj || typeof obj !== "object") return s;
    Object.assign(s, obj);
    s.history = Array.isArray(obj.history) ? obj.history : [];
    return s;
  }
}

// ── Module state ─────────────────────────────────────────────────────

const sessions = new Map();
let hostRef = null;
let config = { ...DEFAULTS };
let stats = new Stats();
/** Interval that refreshes the countdown ticker while a retry is pending. */
let tickerTimer = null;

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = new SessionState();
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
    .catch((err) => hostRef?.log("warn", `Stats persist failed: ${err}`));
}

function updateDashboard() {
  if (!hostRef) return;
  const blocked = [...sessions.values()].filter((s) => s.blocked).length;
  const parts = [`${stats.retriesSent} retries`];
  if (stats.breakerTrips > 0) parts.push(`${stats.breakerTrips} blocks`);
  if (blocked > 0) parts.push(`${blocked} session(s) blocked`);
  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle: parts.join(" · ") });
}

// ── Countdown ticker ─────────────────────────────────────────────────

function pendingCount() {
  let count = 0;
  for (const s of sessions.values()) if (s.timer) count++;
  return count;
}

function refreshTicker() {
  if (!hostRef) return;
  let soonest = 0;
  for (const s of sessions.values()) {
    if (!s.timer) continue;
    if (soonest === 0 || s.dueAt < soonest) soonest = s.dueAt;
  }
  if (soonest === 0) {
    stopTicker();
    return;
  }
  const remaining = Math.max(0, Math.round((soonest - Date.now()) / 1000));
  const extra = pendingCount() > 1 ? ` (${pendingCount()} sessions)` : "";
  hostRef.setTicker({
    id: `${PLUGIN_ID}:countdown`,
    text: `Model at capacity — retry in ${remaining}s${extra}`,
    label: "At-Capacity",
    icon: ICON,
    priority: 40,
    ttlMs: config.tickerIntervalMs * 3,
  });
}

function startTicker() {
  refreshTicker();
  if (tickerTimer) return;
  tickerTimer = setInterval(refreshTicker, config.tickerIntervalMs);
}

function stopTicker() {
  if (tickerTimer) {
    clearInterval(tickerTimer);
    tickerTimer = null;
  }
  hostRef?.clearTicker(`${PLUGIN_ID}:countdown`);
}

// ── Rolling window + breaker ─────────────────────────────────────────

function pruneWindow(session, now) {
  session.retryTimes = session.retryTimes.filter((t) => now - t < config.windowMs);
}

function tripBreaker(sessionId, session, now) {
  if (!hostRef || session.blocked) return;
  session.blocked = true;
  session.blockedAt = now;
  cancelRetry(sessionId, session, "breaker tripped");

  stats.breakerTrips++;
  stats.record(sessionId, "blocked", `${session.retryTimes.length} retries in the window`);
  saveStats();

  hostRef.log(
    "warn",
    `Breaker tripped — ${session.retryTimes.length} retries within ${config.windowMs / 60000}min → blocked ${sessionId.slice(0, 8)}`
  );
  hostRef.setTicker({
    id: `${PLUGIN_ID}:blocked`,
    text: `At-capacity retries blocked — ${config.maxRetriesPerWindow} used in the last hour`,
    label: "At-Capacity",
    icon: ICON,
    priority: 100,
    ttlMs: 5 * 60 * 1000,
  });
  hostRef.addItem({
    id: `${PLUGIN_ID}:blocked:${sessionId}`,
    pluginId: PLUGIN_ID,
    sectionId: SECTION_ID,
    title: "Retries blocked",
    subtitle: `Session ${sessionId.slice(0, 8)} — ${config.maxRetriesPerWindow} retries in one hour`,
    icon: ICON,
    iconColor: "var(--error)",
    dismissible: true,
    contentUri: `${PLUGIN_ID}:stats`,
  });
  hostRef
    .playNotificationSound("warning")
    .catch((err) => hostRef?.log("warn", `Sound failed: ${err}`));

  updateDashboard();
}

function unblock(sessionId, session, reason) {
  if (!session.blocked) return;
  session.blocked = false;
  session.blockedAt = 0;
  session.retryTimes = [];
  hostRef?.removeItem(`${PLUGIN_ID}:blocked:${sessionId}`);
  hostRef?.clearTicker(`${PLUGIN_ID}:blocked`);
  hostRef?.log("info", `Unblocked ${sessionId.slice(0, 8)} (${reason})`);
  updateDashboard();
}

// ── Retry scheduling ─────────────────────────────────────────────────

function cancelRetry(sessionId, session, reason) {
  if (!session.timer) return;
  clearTimeout(session.timer);
  session.timer = null;
  session.dueAt = 0;
  hostRef?.log("info", `Pending retry cancelled (${reason}) → ${sessionId.slice(0, 8)}`);
  if (pendingCount() === 0) stopTicker();
  else refreshTicker();
}

function scheduleRetry(sessionId, session, now) {
  session.detectedAt = now;
  session.dueAt = now + config.retryDelayMs;
  session.timer = setTimeout(() => {
    fireRetry(sessionId).catch((err) => hostRef?.log("error", `Retry failed: ${err}`));
  }, config.retryDelayMs);

  stats.incidents++;
  stats.record(sessionId, "detected", `retry in ${config.retryDelayMs / 1000}s`);
  saveStats();

  hostRef?.log(
    "info",
    `Model at capacity → retry in ${config.retryDelayMs / 1000}s (${session.retryTimes.length + 1}/${config.maxRetriesPerWindow} this hour) → ${sessionId.slice(0, 8)}`
  );
  startTicker();
  updateDashboard();
}

function skipRetry(sessionId, session, reason) {
  stats.retriesSkipped++;
  stats.record(sessionId, "skipped", reason);
  saveStats();
  hostRef?.log("info", `Retry skipped (${reason}) → ${sessionId.slice(0, 8)}`);
  // The incident stays unresolved on screen. Let the next detection schedule a
  // new retry instead of leaving the session stuck behind the debounce.
  session.lastDetectAt = 0;
  updateDashboard();
}

async function fireRetry(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !hostRef) return;

  const dueAt = session.dueAt;
  session.timer = null;
  session.dueAt = 0;
  if (pendingCount() === 0) stopTicker();

  const now = Date.now();

  // setTimeout is suspended while the machine sleeps, so on resume the retry
  // fires long after it was due. The incident on screen is then stale — the
  // user has seen it, and a blind `retry` would land in an unknown state.
  if (now - dueAt > config.retryDelayMs) {
    skipRetry(sessionId, session, `stale by ${Math.round((now - dueAt) / 1000)}s (sleep/wake)`);
    return;
  }
  if (session.blocked) return;
  // The agent restarted work on its own (self-retry, or the user resent the
  // turn). Only a busy transition that came *after* the detection proves this —
  // the at-capacity message itself arrives while the session is still busy, and
  // that stale state must not suppress the retry.
  if (session.shellState === "busy" && session.lastBusyAt > session.detectedAt) {
    skipRetry(sessionId, session, "agent resumed work by itself");
    return;
  }

  const buffer = await hostRef
    .invoke("get_input_buffer_content", { sessionId })
    .catch(() => "");
  if (buffer && buffer.trim().length > 0) {
    skipRetry(sessionId, session, "user is typing");
    return;
  }

  try {
    await hostRef.sendAgentInput(sessionId, config.retryText);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found") || msg.includes("No such session")) {
      sessions.delete(sessionId);
      return;
    }
    hostRef.log("error", `Retry send failed: ${err}`);
    skipRetry(sessionId, session, `send failed: ${msg}`);
    return;
  }

  pruneWindow(session, now);
  session.retryTimes.push(now);
  stats.retriesSent++;
  stats.record(sessionId, "retried", `${session.retryTimes.length}/${config.maxRetriesPerWindow} this hour`);
  saveStats();

  hostRef.log(
    "info",
    `Sent "${config.retryText}" (${session.retryTimes.length}/${config.maxRetriesPerWindow} this hour) → ${sessionId.slice(0, 8)}`
  );
  hostRef.setTicker({
    id: `${PLUGIN_ID}:countdown`,
    text: `Retry sent (${session.retryTimes.length}/${config.maxRetriesPerWindow} this hour)`,
    label: "At-Capacity",
    icon: ICON,
    priority: 30,
    ttlMs: 10 * 1000,
  });
  updateDashboard();
}

// ── Detection ────────────────────────────────────────────────────────

function onCapacityDetected(sessionId) {
  if (!hostRef) return;
  const now = Date.now();
  const session = getSession(sessionId);

  if (session.blocked) return;
  // A pending retry already owns this incident. Every repaint of the same
  // warning line lands here.
  if (session.timer) return;
  if (session.lastDetectAt > 0 && now - session.lastDetectAt < config.detectDebounceMs) return;
  session.lastDetectAt = now;

  pruneWindow(session, now);
  if (session.retryTimes.length >= config.maxRetriesPerWindow) {
    tripBreaker(sessionId, session, now);
    return;
  }

  scheduleRetry(sessionId, session, now);
}

// ── Plugin lifecycle ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    host
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "config.json" })
      .then((raw) => {
        if (!raw) return;
        try {
          config = { ...DEFAULTS, ...JSON.parse(raw) };
          host.log(
            "info",
            `Config: delay=${config.retryDelayMs / 1000}s max=${config.maxRetriesPerWindow}/${config.windowMs / 60000}min text="${config.retryText}"`
          );
        } catch (err) {
          host.log("warn", `Config parse failed (using defaults): ${err}`);
        }
      })
      .catch(() => {});

    host
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "stats.json" })
      .then((raw) => {
        if (!raw) return;
        stats = Stats.fromJSON(JSON.parse(raw));
        updateDashboard();
      })
      .catch(() => {});

    host.registerSection({
      id: SECTION_ID,
      label: "AT-CAPACITY RETRY",
      priority: 66,
      canDismissAll: false,
    });

    host.registerOutputWatcher({
      pattern: CAPACITY_RE,
      onMatch(_match, sessionId) {
        onCapacityDetected(sessionId);
      },
    });

    host.addItem({
      id: `${PLUGIN_ID}:dashboard`,
      pluginId: PLUGIN_ID,
      sectionId: SECTION_ID,
      title: "At-Capacity Retry",
      subtitle: "No retries sent yet",
      icon: ICON,
      dismissible: false,
      contentUri: `${PLUGIN_ID}:stats`,
    });

    host.registerDashboard({
      label: "At-Capacity Retry",
      icon: ICON,
      open: () => host.openMarkdownPanel("At-Capacity Retry", `${PLUGIN_ID}:stats`),
    });

    host.registerMarkdownProvider(PLUGIN_ID, {
      provideContent() {
        const now = Date.now();
        let md = "# At-Capacity Retry\n\n";
        md += "Retries a Codex turn that failed with `Selected model is at capacity`.\n\n";

        md += "## Summary\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Incidents detected | ${stats.incidents} |\n`;
        md += `| Retries sent | ${stats.retriesSent} |\n`;
        md += `| Retries skipped | ${stats.retriesSkipped} |\n`;
        md += `| Breaker trips | ${stats.breakerTrips} |\n`;

        md += "\n## Configuration\n\n";
        md += "| Setting | Value |\n|---------|-------|\n";
        md += `| Retry delay | ${config.retryDelayMs / 1000}s |\n`;
        md += `| Max retries per window | ${config.maxRetriesPerWindow} |\n`;
        md += `| Window | ${config.windowMs / 60000} min |\n`;
        md += `| Retry text | \`${config.retryText}\` |\n`;
        md += `| Detection debounce | ${config.detectDebounceMs / 1000}s |\n`;

        if (sessions.size > 0) {
          md += "\n## Sessions\n\n";
          md += "| Session | State | Retries in window | Pending |\n";
          md += "|---------|-------|-------------------|---------|\n";
          for (const [sid, s] of sessions) {
            pruneWindow(s, now);
            const pending = s.timer
              ? `retry in ${Math.max(0, Math.round((s.dueAt - now) / 1000))}s`
              : "-";
            md += `| ${sid.slice(0, 8)} | ${s.blocked ? "**blocked**" : "armed"} | ${s.retryTimes.length}/${config.maxRetriesPerWindow} | ${pending} |\n`;
          }
          md += "\nA blocked session is unblocked by your own input in that terminal.\n";
        }

        if (stats.history.length > 0) {
          md += "\n## Recent History\n\n";
          md += "| Time | Session | Event | Detail |\n|------|---------|-------|--------|\n";
          for (const h of [...stats.history].reverse().slice(0, 20)) {
            md += `| ${h.ts.slice(11, 19)} | ${h.session} | ${h.event} | ${h.detail} |\n`;
          }
        }

        return md;
      },
    });

    // ── Shell state — a busy agent needs no retry ───────────────────
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.shellState = payload?.state ?? null;
      if (session.shellState === "busy") session.lastBusyAt = Date.now();
    });

    // ── Real user input — the human took over ───────────────────────
    host.registerStructuredEventHandler("user-input", (payload, sessionId) => {
      const content = (payload?.content ?? "").trim();
      // Our own retry echoes back as a user-input event. It must not cancel
      // the incident it belongs to, nor reset the hour budget.
      if (content === config.retryText.trim()) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      cancelRetry(sessionId, session, "user input");
      unblock(sessionId, session, "user input");
      session.lastDetectAt = 0;
    });

    // ── Session teardown ────────────────────────────────────────────
    const drop = (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      cancelRetry(sessionId, session, "session gone");
      hostRef?.removeItem(`${PLUGIN_ID}:blocked:${sessionId}`);
      sessions.delete(sessionId);
      updateDashboard();
    };
    host.registerStructuredEventHandler("session-closed", (_payload, sessionId) => drop(sessionId));
    host.onStateChange((event) => {
      if (event.type === "agent-stopped" && event.sessionId) drop(event.sessionId);
    });

    host.log("info", "Active");
  },

  onunload() {
    for (const [sessionId, session] of sessions) {
      cancelRetry(sessionId, session, "plugin unload");
    }
    stopTicker();
    sessions.clear();
    hostRef = null;
  },
};
