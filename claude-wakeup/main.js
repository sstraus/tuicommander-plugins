/**
 * Claude Wakeup Plugin
 *
 * Wakes Claude Code when it stops producing output without asking a question
 * — i.e. "chrome without question". After 20s of idle with no pending
 * question, no active sub-tasks, and no choice prompt, sends a verification
 * message. If the agent replies `done`, disarms until the next real user
 * turn. Otherwise re-pings up to 3 times.
 */

const PLUGIN_ID = "claude-wakeup";
const SECTION_ID = "claude-wakeup";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 4a1 1 0 0 1 2 0v4a1 1 0 0 1-2 0V4z"/></svg>';

const WAKE_MESSAGE =
  "Verify all pending tasks are done. Reply exactly `done` if truly finished, otherwise continue";

const DEFAULTS = {
  /** Idle time before the first wake ping. */
  idleThresholdMs: 20 * 1000,
  /** Delay after sending a ping before we verify the agent's reply. */
  verifyDelayMs: 8 * 1000,
  /** Maximum pings per stall stretch. After this, we wait for a real user turn. */
  maxWakes: 3,
  /** Safety ceiling across stalls in a single session. Never resets. */
  maxWakesEver: 12,
  /** Scheduler tick. */
  checkIntervalMs: 5 * 1000,
  /** Minimum busy duration to count as real agent activity (ms). */
  minBusyDurationMs: 1500,
  /** Question event is considered stale after this age (ms). */
  questionStaleMs: 30 * 60 * 1000,
  /** Pending-ping watchdog. If verify doesn't clear it, force-clear. */
  pendingTimeoutMs: 60 * 1000,
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
    this.wakeCount = 0;
    this.totalWakesEver = 0;
    this.pendingWake = false;
    this.pendingWakeAt = 0;
    this.lastWakeSentAt = 0;
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
    .catch((err) => hostRef?.log("warn", `Stats persist failed: ${err}`));
}

function updateDashboard() {
  if (!hostRef) return;
  const parts = [`${stats.wakesSent} sent`];
  if (stats.doneConfirmed > 0) parts.push(`${stats.doneConfirmed} done`);
  if (stats.noReply > 0) parts.push(`${stats.noReply} no-reply`);
  hostRef.updateItem(`${PLUGIN_ID}:dashboard`, { subtitle: parts.join(" · ") });
}

// ── Output parsing ───────────────────────────────────────────────────

/** Regex for the `done` reply. Permissive: accepts punctuation and common prefixes. */
const DONE_RE = /^[\s\-*>⏺·•]*done[.!?"'`]*\s*$/i;

/** Rows that are decorative chrome rather than real assistant text. */
function isChromeRow(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  // Box-drawing / rounded-frame chars used by Claude Code's input widget
  if (/^[\s─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬]+$/.test(t)) return true;
  // Prompt lines (> or ❯ leading)
  if (/^[│╭╰]?\s*[>❯›]\s/.test(t)) return true;
  if (t === ">" || t === "❯") return true;
  // Status lines: start with ? or ⏵ or use known footer tokens
  if (/^[?⏵⏺]/.test(t) && t.length < 3) return true;
  // Mode-line (CC shows hints like "shift+tab to cycle modes")
  if (/shift\+tab|esc to interrupt|tokens left|[\u2500-\u257F]/.test(t) && t.length < 80) {
    // Only strip if it looks like a footer hint (short, has box-drawing or known tokens)
    if (/^\s*[\u2500-\u257F]/.test(t) || /⏵⏵/.test(t)) return true;
  }
  return false;
}

/**
 * Scan PTY output from the bottom up to find the last line that looks like
 * an assistant reply (non-chrome, non-prompt, not our own wake message).
 * Returns the matched line or null.
 */
function extractLastAssistantLine(output) {
  if (!output) return null;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (isChromeRow(trimmed)) continue;
    if (trimmed.includes(WAKE_MESSAGE)) continue;
    // Strip leading assistant bullet "⏺ " if present
    const cleaned = trimmed.replace(/^[⏺·•]\s+/, "");
    return cleaned;
  }
  return null;
}

function isDoneReply(line) {
  if (!line) return false;
  return DONE_RE.test(line.trim());
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
  if (session.lastIdleAt === 0) return false;
  if (now - session.lastIdleAt < config.idleThresholdMs) return false;
  return true;
}

function checkWakeups() {
  if (!hostRef) return;
  const now = Date.now();

  for (const [sessionId, session] of sessions) {
    // Watchdog: stuck pendingWake → force-clear
    if (
      session.pendingWake &&
      session.pendingWakeAt > 0 &&
      now - session.pendingWakeAt > config.pendingTimeoutMs
    ) {
      hostRef.log(
        "warn",
        `pendingWake stuck ${Math.round((now - session.pendingWakeAt) / 1000)}s → clearing ${sessionId.slice(0, 8)}`
      );
      session.pendingWake = false;
      session.pendingWakeAt = 0;
    }

    if (!canWake(session, now)) continue;

    session.pendingWake = true;
    session.pendingWakeAt = now;
    session.lastWakeSentAt = now;
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
      .sendAgentInput(sessionId, WAKE_MESSAGE)
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("not found") || msg.includes("No such session")) {
          sessions.delete(sessionId);
          return;
        }
        hostRef.log("error", `Wake send failed: ${err}`);
        session.pendingWake = false;
        session.pendingWakeAt = 0;
        session.wakeCount--;
        session.totalWakesEver--;
      });

    setTimeout(() => verifyReply(sessionId), config.verifyDelayMs);
  }
}

/**
 * Verify the agent's reply to our wake message. Reads the PTY, scans the
 * last assistant line, and decides: `done` → disarm, otherwise reset idle
 * timer so the next tick can re-ping.
 */
async function verifyReply(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !hostRef) return;

  let output = null;
  try {
    output = await hostRef.readSessionOutput(sessionId, 80);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found") || msg.includes("Session not found")) {
      sessions.delete(sessionId);
      return;
    }
    hostRef.log("warn", `readSessionOutput failed for ${sessionId.slice(0, 8)}: ${err}`);
  }

  const lastLine = extractLastAssistantLine(output);
  const done = isDoneReply(lastLine);

  session.pendingWake = false;
  session.pendingWakeAt = 0;
  // Reset idle timer so further waking has to wait another threshold.
  session.lastIdleAt = Date.now();

  if (done) {
    stats.record(sessionId, "done");
    session.disarmed = true;
    session.wakeCount = 0;
    hostRef.log(
      "info",
      `Wakeup confirmed DONE → ${sessionId.slice(0, 8)} (disarmed until next user turn)`
    );
    hostRef.setTicker({
      id: `${PLUGIN_ID}:status`,
      text: "Agent confirmed done",
      label: "Wakeup",
      icon: ICON,
      priority: 5,
      ttlMs: 8000,
    });
  } else {
    stats.record(sessionId, "no-reply");
    hostRef.log(
      "info",
      `Wakeup reply='${lastLine ?? "(none)"}' — not done, will retry ${sessionId.slice(0, 8)}`
    );
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
        md += `| Verify delay | ${config.verifyDelayMs / 1000}s |\n`;
        md += `| Max wakes per stall | ${config.maxWakes} |\n`;
        md += `| Max wakes per session | ${config.maxWakesEver} |\n`;
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
    host.onStateChange((event) => {
      if (event.type === "agent-started" && event.sessionId) {
        getSession(event.sessionId);
        host.log("info", `Agent started in ${event.sessionId.slice(0, 8)} — tracking`);
      }
      if (event.type === "agent-stopped" && event.sessionId) {
        sessions.delete(event.sessionId);
      }
    });

    // ── Shell state ──────────────────────────────────────────────────
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = getSession(sessionId);
      const prev = session.shellState;
      session.shellState = payload.state;
      const now = Date.now();

      if (payload.state === "busy") {
        session.lastBusyAt = now;
        // Busy preceded by a real user turn → re-arm
        if (
          session.disarmed &&
          session.lastUserInputAt > 0 &&
          now - session.lastUserInputAt < 5 * 60 * 1000
        ) {
          session.disarmed = false;
          session.wakeCount = 0;
          host.log("info", `Re-armed on user-driven busy → ${sessionId.slice(0, 8)}`);
        }
        return;
      }

      if (payload.state === "idle") {
        // Short busy blips don't count as real activity — ignore them.
        if (prev === "busy") {
          const busyDuration = session.lastBusyAt ? now - session.lastBusyAt : 0;
          if (busyDuration < config.minBusyDurationMs) {
            // Keep existing idle timer running.
            return;
          }
          session.lastIdleAt = now;
          return;
        }
        if (session.lastIdleAt === 0) session.lastIdleAt = now;
      }
    });

    // ── Question (pending answer from user) ─────────────────────────
    host.registerStructuredEventHandler("question", (_payload, sessionId) => {
      const session = getSession(sessionId);
      session.hasQuestionAt = Date.now();
    });

    // ── Sub-tasks running (background work) ─────────────────────────
    host.registerStructuredEventHandler("active-subtasks", (payload, sessionId) => {
      const session = getSession(sessionId);
      session.activeSubtasks = payload?.count ?? 0;
    });

    // ── Choice prompts (numbered menus) ─────────────────────────────
    host.registerStructuredEventHandler("choice-prompt", (_payload, sessionId) => {
      const session = getSession(sessionId);
      session.choicePromptActive = true;
    });

    // ── Real user input — re-arms and clears question/choice state ──
    host.registerStructuredEventHandler("user-input", (payload, sessionId) => {
      const content = payload?.content ?? "";
      if (content.includes(WAKE_MESSAGE)) return; // our own wake — ignore
      const session = getSession(sessionId);
      session.lastUserInputAt = Date.now();
      session.hasQuestionAt = 0;
      session.choicePromptActive = false;
      // Real input → new stall context; reset per-stall counter
      session.wakeCount = 0;
    });

    // ── Usage exhausted — stop waking ───────────────────────────────
    host.registerStructuredEventHandler("usage-exhausted", (_payload, sessionId) => {
      const session = getSession(sessionId);
      session.disarmed = true;
      session.pendingWake = false;
      host.log("warn", `Usage exhausted → disarming wakeup for ${sessionId.slice(0, 8)}`);
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
