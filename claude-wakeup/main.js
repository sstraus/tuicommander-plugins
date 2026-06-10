/**
 * Claude Wakeup Plugin
 *
 * Wakes Claude Code when it stops producing output without asking a question
 * — i.e. "chrome without question". After 20s of idle with no pending
 * question, no active sub-tasks, and no choice prompt, sends a verification
 * message. If the agent replies briefly (short busy cycle), assumes "done"
 * and disarms until the next real user turn. Otherwise re-pings up to 3 times.
 *
 * "Done" detection strategy: after sending a wake, we watch the busy→idle
 * transition. A short busy cycle (<8s) means the agent just acknowledged
 * (e.g. replied "done"). A long busy cycle (>10s) means it continued working.
 * OutputWatcher is kept as a bonus fast-path for agents that produce a clean
 * "done" line, but the primary signal is the busy duration.
 */

const PLUGIN_ID = "claude-wakeup";
const SECTION_ID = "claude-wakeup";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 4a1 1 0 0 1 2 0v4a1 1 0 0 1-2 0V4z"/></svg>';

const WAKE_MESSAGE =
  "Continue, or reply `done` if finished.";

const ERROR_LOOP_MESSAGE =
  "You have hit multiple consecutive errors. Stop, re-check your working directory and assumptions, then try a different approach.";

const DEFAULTS = {
  idleThresholdMs: 20 * 1000,
  maxWakes: 3,
  maxWakesEver: 12,
  checkIntervalMs: 5 * 1000,
  minBusyDurationMs: 1500,
  questionStaleMs: 30 * 60 * 1000,
  pendingTimeoutMs: 60 * 1000,
  /** Busy cycle shorter than this after a wake = agent acknowledged ("done"). */
  doneMaxBusyMs: 8 * 1000,
  /** Consecutive tool errors before sending an error-loop nudge. */
  errorLoopThreshold: 3,
};

// ── Per-session state ────────────────────────────────────────────────

class SessionTracker {
  constructor() {
    this.shellState = null;
    this.lastIdleAt = 0;
    this.lastBusyAt = 0;
    this.lastUserInputAt = 0;
    this.hasQuestionAt = 0;
    this.activeSubtasks = 0;
    this.choicePromptActive = false;
    this.disarmed = false;
    this.disarmedAt = 0;
    this.wakeCount = 0;
    this.totalWakesEver = 0;
    this.pendingWake = false;
    this.pendingWakeAt = 0;
    this.lastWakeSentAt = 0;
    this.wakeBusySeen = false;
    this.consecutiveErrors = 0;
    this.errorLoopNudged = false;
  }
}

class Stats {
  constructor() {
    this.wakesSent = 0;
    this.doneConfirmed = 0;
    this.noReply = 0;
    this.history = [];
  }

  record(sessionId, result) {
    this.wakesSent++;
    if (result === "done") this.doneConfirmed++;
    else if (result === "no-reply") this.noReply++;
    this.history.push({
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      result,
    });
    if (this.history.length > 50) this.history.shift();
  }

  toJSON() {
    return {
      wakesSent: this.wakesSent,
      doneConfirmed: this.doneConfirmed,
      noReply: this.noReply,
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
  const parts = [`${stats.wakesSent} sent`];
  if (stats.doneConfirmed > 0) parts.push(`${stats.doneConfirmed} done`);
  if (stats.noReply > 0) parts.push(`${stats.noReply} no-reply`);
  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle: parts.join(" · ") });
}

// ── Output matching (secondary fast-path) ────────────────────────────

const DONE_RE = /^[\s\-*>⏺●◉⬤·•]*done[.!?"'`,:;]*\s*$/i;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

const WAKE_MESSAGE_CLEAN = WAKE_MESSAGE.replace(/`/g, "");

function isDoneReply(line) {
  const clean = line.replace(ANSI_RE, "");
  if (clean.includes(WAKE_MESSAGE) || clean.includes(WAKE_MESSAGE_CLEAN)) return false;
  if (clean.includes("Continue") && clean.includes("finished")) return false;
  return DONE_RE.test(clean);
}

// ── Wakeup check ─────────────────────────────────────────────────────

function canWake(session, now) {
  if (session.disarmed) return false;
  if (session.shellState !== "idle") return false;
  if (session.pendingWake) return false;
  if (session.wakeCount >= config.maxWakes) return false;
  if (session.totalWakesEver >= config.maxWakesEver) return false;
  if (session.activeSubtasks > 0) return false;
  if (session.choicePromptActive) return false;
  if (session.hasQuestionAt > 0 && now - session.hasQuestionAt < config.questionStaleMs) {
    return false;
  }
  if (session.lastUserInputAt > 0 && now - session.lastUserInputAt < config.idleThresholdMs * 2) {
    return false;
  }
  if (session.lastIdleAt === 0) return false;
  if (now - session.lastIdleAt < config.idleThresholdMs) return false;
  return true;
}

function checkWakeups() {
  if (!hostRef) return;
  const now = Date.now();

  for (const [sessionId, session] of sessions) {
    if (
      session.pendingWake &&
      session.pendingWakeAt > 0 &&
      now - session.pendingWakeAt > config.pendingTimeoutMs
    ) {
      hostRef.log(
        "warn",
        `pendingWake stuck ${Math.round((now - session.pendingWakeAt) / 1000)}s → expiring ${sessionId.slice(0, 8)}`
      );
      expirePendingWake(sessionId);
    }

    if (!canWake(session, now)) continue;

    session.pendingWake = true;
    session.pendingWakeAt = now;
    session.lastWakeSentAt = now;
    session.wakeBusySeen = false;
    session.wakeCount++;
    session.totalWakesEver++;

    const count = session.wakeCount;
    const max = config.maxWakes;

    hostRef.log("info", `Wakeup ${count}/${max} → ${sessionId.slice(0, 8)}`);
    hostRef.setTicker({
      id: `${PLUGIN_ID}:status`,
      text: `Wakeup ${count}/${max}`,
      label: "Wakeup",
      icon: ICON,
      priority: 30,
      ttlMs: 12000,
    });

    hostRef
      .invoke("get_input_buffer_content", { sessionId })
      .then((content) => {
        if (content && content.trim().length > 0) {
          hostRef.log("debug", `Wakeup skipped — user typing in ${sessionId.slice(0, 8)}`);
          session.pendingWake = false;
          session.pendingWakeAt = 0;
          session.wakeBusySeen = false;
          session.wakeCount--;
          session.totalWakesEver--;
          // Unsent text in the input buffer is user composition activity.
          // Record it so canWake()'s idle guard suppresses re-attempts for
          // idleThresholdMs*2 instead of busy-retrying every checkIntervalMs
          // (which logged + IPC'd every 5s forever while text sat unsent).
          session.lastUserInputAt = now;
          return;
        }
        return hostRef.sendAgentInput(sessionId, WAKE_MESSAGE);
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("not found") || msg.includes("No such session")) {
          sessions.delete(sessionId);
          return;
        }
        hostRef.log("error", `Wake send failed: ${err}`);
        session.pendingWake = false;
        session.pendingWakeAt = 0;
        session.wakeBusySeen = false;
        session.wakeCount--;
        session.totalWakesEver--;
      });
  }
}

function confirmDone(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session || !hostRef) return;

  session.pendingWake = false;
  session.pendingWakeAt = 0;
  session.wakeBusySeen = false;
  session.lastIdleAt = Date.now();

  stats.record(sessionId, "done");
  session.disarmed = true;
  session.disarmedAt = Date.now();
  session.wakeCount = 0;
  hostRef.log(
    "info",
    `Wakeup confirmed DONE (${reason}) → ${sessionId.slice(0, 8)} (disarmed until next user turn)`
  );
  hostRef.setTicker({
    id: `${PLUGIN_ID}:status`,
    text: "Agent confirmed done",
    label: "Wakeup",
    icon: ICON,
    priority: 5,
    ttlMs: 8000,
  });

  saveStats();
  updateDashboard();
}

function expirePendingWake(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !hostRef) return;
  if (!session.pendingWake) return;

  session.pendingWake = false;
  session.pendingWakeAt = 0;
  session.wakeBusySeen = false;
  session.lastIdleAt = Date.now();

  stats.record(sessionId, "no-reply");

  if (session.wakeCount >= config.maxWakes) {
    session.disarmed = true;
    session.disarmedAt = Date.now();
    hostRef.log("warn", `${config.maxWakes} no-replies → disarming ${sessionId.slice(0, 8)} until next user turn`);
  } else {
    hostRef.log("info", `Wakeup no reply (${session.wakeCount}/${config.maxWakes}) → ${sessionId.slice(0, 8)}, will retry`);
  }

  saveStats();
  updateDashboard();
}

// ── Plugin lifecycle ─────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    host
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "config.json" })
      .then((raw) => {
        try {
          config = { ...DEFAULTS, ...JSON.parse(raw) };
          host.log(
            "info",
            `Config: threshold=${config.idleThresholdMs / 1000}s max=${config.maxWakes}`
          );
        } catch (err) {
          host.log("warn", `Config parse failed (using defaults): ${err}`);
        }
      })
      .catch(() => {
        host.log("info", `Defaults: threshold=${config.idleThresholdMs / 1000}s max=${config.maxWakes}`);
      });

    host
      .invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "stats.json" })
      .then((raw) => {
        stats = Stats.fromJSON(JSON.parse(raw));
        updateDashboard();
      })
      .catch(() => {});

    host.registerSection({
      id: SECTION_ID,
      label: "CLAUDE WAKEUP",
      priority: 65,
      canDismissAll: false,
    });

    // OutputWatcher: catches "done" in PTY output. Uses a time window from
    // lastWakeSentAt rather than gating on pendingWake, because the busy→idle
    // handler may clear pendingWake (long cycle) before the watcher fires.
    host.registerOutputWatcher({
      pattern: /done/i,
      onMatch(match, sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        if (session.disarmed) return;
        const sinceWake = Date.now() - (session.lastWakeSentAt || 0);
        if (!session.lastWakeSentAt || sinceWake > config.pendingTimeoutMs) return;
        const fullLine = match.input ?? "";
        if (isDoneReply(fullLine)) {
          host.log("info", `OutputWatcher: "${fullLine}" (${Math.round(sinceWake / 1000)}s after wake)`);
          confirmDone(sessionId, "output-watcher");
        }
      },
    });

    host.addItem({
      id: `${PLUGIN_ID}:dashboard`,
      pluginId: PLUGIN_ID,
      sectionId: SECTION_ID,
      title: "Claude Wakeup Stats",
      subtitle: "No wakeups sent yet",
      icon: ICON,
      dismissible: false,
      contentUri: `${PLUGIN_ID}:stats`,
    });

    host.registerDashboard({
      label: "Wakeup Stats",
      icon: ICON,
      open: () => host.openMarkdownPanel("Claude Wakeup", `${PLUGIN_ID}:stats`),
    });

    host.registerMarkdownProvider(PLUGIN_ID, {
      provideContent() {
        const doneRate =
          stats.wakesSent > 0
            ? Math.round((stats.doneConfirmed / stats.wakesSent) * 100)
            : 0;

        let md = "# Claude Wakeup\n\n";
        md += "Wakes Claude Code when it stalls without asking a question.\n\n";
        md += "## Summary\n\n";
        md += "| Metric | Value |\n|--------|-------|\n";
        md += `| Wakeups sent | ${stats.wakesSent} |\n`;
        md += `| Confirmed \`done\` | ${stats.doneConfirmed} |\n`;
        md += `| No/other reply | ${stats.noReply} |\n`;
        md += `| \`done\` rate | ${doneRate}% |\n`;

        md += "\n## Configuration\n\n";
        md += "| Setting | Value |\n|---------|-------|\n";
        md += `| Idle threshold | ${config.idleThresholdMs / 1000}s |\n`;
        md += `| Max wakes per stall | ${config.maxWakes} |\n`;
        md += `| Max wakes per session | ${config.maxWakesEver} |\n`;
        md += `| Done busy threshold | ${config.doneMaxBusyMs / 1000}s |\n`;
        md += `| Wake message | \`${WAKE_MESSAGE}\` |\n`;

        if (sessions.size > 0) {
          md += "\n## Active Sessions\n\n";
          md += "| Session | State | Armed | Wakes (stall/session) |\n";
          md += "|---------|-------|-------|----------------------|\n";
          for (const [sid, s] of sessions) {
            md += `| ${sid.slice(0, 8)} | ${s.shellState ?? "-"} | ${s.disarmed ? "no" : "yes"} | ${s.wakeCount}/${s.totalWakesEver} |\n`;
          }
        }

        if (stats.history.length > 0) {
          md += "\n## Recent History\n\n";
          md += "| Time | Session | Result |\n|------|---------|--------|\n";
          for (const h of [...stats.history].reverse().slice(0, 20)) {
            md += `| ${h.ts.slice(11, 19)} | ${h.session} | ${h.result} |\n`;
          }
        }

        return md;
      },
    });

    // ── Agent lifecycle ─────────────────────────────────────────────
    // Only agent-started creates a session tracker. All other handlers
    // use sessions.get() — non-agent terminals are never tracked.
    host.onStateChange((event) => {
      if (event.type === "agent-started" && event.sessionId) {
        let s = sessions.get(event.sessionId);
        if (!s) {
          s = new SessionTracker();
          sessions.set(event.sessionId, s);
        }
        host.log("info", `Agent started in ${event.sessionId.slice(0, 8)} — tracking`);
      }
      if (event.type === "agent-stopped" && event.sessionId) {
        sessions.delete(event.sessionId);
      }
    });

    // ── Shell state ──────────────────────────────────────────────────
    // No agent_type guard here — pluginMatchesSession already filters
    // by agentTypes:["claude"]. The extra guard blocked events from
    // synthetic replays and edge cases where the Rust payload omitted
    // agent_type, breaking busy→idle tracking and done detection.
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      const prev = session.shellState;
      session.shellState = payload.state;
      const now = Date.now();

      if (payload.state === "busy") {
        session.lastBusyAt = now;
        // Track that the agent started processing after our wake
        if (session.pendingWake && !session.wakeBusySeen) {
          session.wakeBusySeen = true;
          host.log("debug", `Wake-busy started → ${sessionId.slice(0, 8)}`);
        }
        return;
      }

      if (payload.state === "idle") {
        if (prev === "busy") {
          const busyDuration = session.lastBusyAt ? now - session.lastBusyAt : 0;

          // ALWAYS reset the idle clock — even for short blips (typing).
          // Without this, typing doesn't push lastIdleAt forward and
          // canWake fires while the user is actively present.
          session.lastIdleAt = now;

          // PRIMARY "done" detection: short busy cycle after wake = agent
          // just acknowledged briefly (replied "done" or similar).
          if (session.pendingWake && session.wakeBusySeen && busyDuration < config.doneMaxBusyMs) {
            host.log("info", `Short busy cycle ${Math.round(busyDuration / 1000)}s after wake → treating as done`);
            confirmDone(sessionId, `short-busy-${Math.round(busyDuration / 1000)}s`);
            return;
          }

          // Long busy cycle after wake = agent continued working.
          if (session.pendingWake && session.wakeBusySeen && busyDuration >= config.doneMaxBusyMs) {
            host.log("info", `Long busy cycle ${Math.round(busyDuration / 1000)}s after wake → agent continued, clearing pending`);
            session.pendingWake = false;
            session.pendingWakeAt = 0;
            session.wakeBusySeen = false;
          }

          // Skip re-arm/question logic for short blips (typing, spinner)
          if (busyDuration < config.minBusyDurationMs) {
            return;
          }

          // Re-arm only if user gave NEW input AFTER both the disarm AND the
          // last wake sent. Without the lastWakeSentAt guard, the wake's own
          // busy cycle could re-arm the session immediately.
          if (
            session.disarmed &&
            busyDuration > 10000 &&
            session.lastUserInputAt > session.disarmedAt &&
            session.lastUserInputAt > session.lastWakeSentAt &&
            now - session.lastUserInputAt < 5 * 60 * 1000
          ) {
            session.disarmed = false;
            session.disarmedAt = 0;
            session.wakeCount = 0;
            host.log("info", `Re-armed after ${Math.round(busyDuration / 1000)}s busy → ${sessionId.slice(0, 8)}`);
          }

          // If pending wake and a question appeared, cancel the wake
          if (session.pendingWake) {
            const hasQuestion = session.hasQuestionAt > 0 && now - session.hasQuestionAt < config.questionStaleMs;
            if (hasQuestion) {
              session.pendingWake = false;
              session.pendingWakeAt = 0;
              session.wakeBusySeen = false;
              session.wakeCount = Math.max(0, session.wakeCount - 1);
              session.totalWakesEver = Math.max(0, session.totalWakesEver - 1);
              host.log("info", `Wake cancelled — question detected → ${sessionId.slice(0, 8)}`);
            }
          }
          return;
        }
        if (session.lastIdleAt === 0) session.lastIdleAt = now;
      }
    });

    // ── Question (pending answer from user) ─────────────────────────
    host.registerStructuredEventHandler("question", (_payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.hasQuestionAt = Date.now();
    });

    // ── Sub-tasks running (background work) ─────────────────────────
    host.registerStructuredEventHandler("active-subtasks", (payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.activeSubtasks = payload?.count ?? 0;
    });

    // ── Choice prompts (numbered menus) ─────────────────────────────
    host.registerStructuredEventHandler("choice-prompt", (_payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.choicePromptActive = true;
    });

    // ── Real user input — re-arms and clears question/choice state ──
    host.registerStructuredEventHandler("user-input", (payload, sessionId) => {
      const content = payload?.content ?? "";
      if (content.includes(WAKE_MESSAGE)) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      session.lastUserInputAt = Date.now();
      session.hasQuestionAt = 0;
      session.choicePromptActive = false;
      session.wakeCount = 0;
      session.consecutiveErrors = 0;
      session.errorLoopNudged = false;
    });

    // ── Usage exhausted — stop waking ───────────────────────────────
    host.registerStructuredEventHandler("usage-exhausted", (_payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.disarmed = true;
      session.disarmedAt = Date.now();
      session.pendingWake = false;
      session.wakeBusySeen = false;
      host.log("warn", `Usage exhausted → disarming wakeup for ${sessionId.slice(0, 8)}`);
    });

    // ── Tool errors — detect error loops ─────────────────────────────
    host.registerStructuredEventHandler("tool-error", (_payload, sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.disarmed) return;

      session.consecutiveErrors++;
      host.log("debug", `Tool error ${session.consecutiveErrors}/${config.errorLoopThreshold} → ${sessionId.slice(0, 8)}`);

      if (session.consecutiveErrors >= config.errorLoopThreshold && !session.errorLoopNudged) {
        session.errorLoopNudged = true;
        session.wakeCount++;
        session.totalWakesEver++;

        host.log("warn", `Error loop (${session.consecutiveErrors} consecutive) → nudging ${sessionId.slice(0, 8)}`);
        host.setTicker({
          id: `${PLUGIN_ID}:status`,
          text: `Error loop (${session.consecutiveErrors}×)`,
          label: "Wakeup",
          icon: ICON,
          priority: 40,
          ttlMs: 15000,
        });

        host.sendAgentInput(sessionId, ERROR_LOOP_MESSAGE).catch((err) => {
          host.log("error", `Error-loop nudge failed: ${err}`);
        });

        stats.record(sessionId, "error-loop");
        saveStats();
        updateDashboard();
      }
    });

    // ── Session closed ──────────────────────────────────────────────
    host.registerStructuredEventHandler("session-closed", (_payload, sessionId) => {
      sessions.delete(sessionId);
    });

    checkTimer = setInterval(checkWakeups, config.checkIntervalMs);
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
