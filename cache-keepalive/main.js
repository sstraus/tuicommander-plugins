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

const ICON_ACTIVE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3a.5.5 0 0 1 1 0v3.5H11a.5.5 0 0 1 0 1H8a.5.5 0 0 1-.5-.5V4z"/></svg>';

/** Default configuration */
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

/** Per-session tracking state */
class SessionTracker {
  constructor() {
    /** @type {number} timestamp when terminal last became idle */
    this.lastIdleAt = 0;
    /** @type {number} keepalives sent in current idle stretch */
    this.keepaliveCount = 0;
    /** @type {boolean} waiting for our keepalive response */
    this.pendingKeepalive = false;
    /** @type {string|null} */
    this.shellState = null;
  }
}

/** @type {Map<string, SessionTracker>} */
const sessions = new Map();
/** @type {ReturnType<typeof setInterval>|null} */
let checkTimer = null;
/** @type {object|null} */
let hostRef = null;
/** @type {object} */
let config = { ...DEFAULTS };

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = new SessionTracker();
    sessions.set(sessionId, s);
  }
  return s;
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

      hostRef.writePty(sessionId, config.message + "\n").catch((err) => {
        hostRef.log("error", `Keepalive failed for ${sessionId}: ${err}`);
        session.pendingKeepalive = false;
        session.keepaliveCount--;
      });

      hostRef.log("info", `Keepalive ${count}/${max} → ${sessionId.slice(0, 8)}`);
      hostRef.setTicker({
        id: `${PLUGIN_ID}:status`,
        text: `Keepalive ${count}/${max}`,
        label: "Cache",
        icon: ICON_ACTIVE,
        priority: 5,
        ttlMs: 10000,
      });
    } else {
      // Session idle but not yet due — still "active" for monitoring
      if (session.keepaliveCount < config.maxKeepalives) {
        activeCount++;
      }
    }
  }

  // Clear ticker when nothing to monitor
  if (activeCount === 0) {
    hostRef.clearTicker(`${PLUGIN_ID}:status`);
  }
}

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    // Load persisted config (merge with defaults)
    host
      .invoke("read_plugin_data", {
        plugin_id: PLUGIN_ID,
        path: "config.json",
      })
      .then((raw) => {
        const saved = JSON.parse(raw);
        config = { ...DEFAULTS, ...saved };
        host.log("info", `Config loaded: max=${config.maxKeepalives}, ttl=${config.ttlMs}ms`);
      })
      .catch(() => {
        // No config yet — use defaults
        host.log("info", `Using defaults: max=${config.maxKeepalives}, ttl=${config.ttlMs}ms`);
      });

    // Track shell state transitions for all Claude sessions.
    // agentTypes: ["claude"] in manifest ensures we only receive Claude events.
    host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
      const session = getSession(sessionId);
      const prev = session.shellState;
      session.shellState = payload.state;

      if (payload.state === "idle") {
        if (session.pendingKeepalive) {
          // Idle after our keepalive response completed
          session.pendingKeepalive = false;
        } else if (prev === "busy") {
          // Idle after real user activity — reset counter
          session.keepaliveCount = 0;
        }
        session.lastIdleAt = Date.now();
      }
    });

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
    hostRef = null;
  },
};
