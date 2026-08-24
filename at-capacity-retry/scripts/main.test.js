/**
 * Tests for the At-Capacity Retry plugin.
 *
 * Run: node --test at-capacity-retry/scripts/
 *
 * The plugin is driven through the same surface the app gives it: a PluginHost
 * mock that records registrations and calls, plus node's fake timers so the
 * 1-minute delay and the 1-hour window are exercised without waiting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import plugin from "../main.js";

const SESSION = "sess-0123456789";
const CAPACITY_LINE = "⚠ Selected model is at capacity. Please try a different model.";

/** Minimal PluginHost double. Captures registrations so tests can fire events. */
function makeHost() {
  const host = {
    watchers: [],
    eventHandlers: new Map(),
    stateChangeHandlers: [],
    sent: [],
    tickers: [],
    items: new Map(),
    logs: [],
    sounds: [],
    inputBuffer: "",
    pluginData: new Map(),

    log(level, message) {
      host.logs.push({ level, message });
    },
    registerSection() {},
    registerOutputWatcher(watcher) {
      host.watchers.push(watcher);
    },
    registerStructuredEventHandler(type, handler) {
      host.eventHandlers.set(type, handler);
    },
    registerMarkdownProvider(_scheme, provider) {
      host.markdownProvider = provider;
    },
    registerDashboard() {},
    onStateChange(cb) {
      host.stateChangeHandlers.push(cb);
    },
    addItem(item) {
      host.items.set(item.id, item);
    },
    updateItem(id, updates) {
      const existing = host.items.get(id);
      if (existing) Object.assign(existing, updates);
    },
    removeItem(id) {
      host.items.delete(id);
    },
    setTicker(ticker) {
      host.tickers.push(ticker);
    },
    clearTicker() {},
    async playNotificationSound(sound) {
      host.sounds.push(sound);
    },
    async sendAgentInput(sessionId, text) {
      host.sent.push({ sessionId, text });
    },
    async invoke(cmd, args) {
      if (cmd === "read_plugin_data") return host.pluginData.get(args.path) ?? null;
      if (cmd === "write_plugin_data") {
        host.pluginData.set(args.path, args.content);
        return;
      }
      if (cmd === "get_input_buffer_content") return host.inputBuffer;
      throw new Error(`unexpected invoke: ${cmd}`);
    },
  };
  return host;
}

/** Feed a terminal line through every registered output watcher. */
function emitLine(host, line, sessionId = SESSION) {
  for (const watcher of host.watchers) {
    if (watcher.pattern.global) watcher.pattern.lastIndex = 0;
    const match = watcher.pattern.exec(line);
    if (match) watcher.onMatch(match, sessionId);
  }
}

function emitEvent(host, type, payload, sessionId = SESSION) {
  const handler = host.eventHandlers.get(type);
  assert.ok(handler, `no handler registered for "${type}"`);
  handler(payload, sessionId);
}

/**
 * Advance fake time and let the microtask queue drain, so the async retry path
 * (input-buffer probe → sendAgentInput) completes before assertions run.
 */
async function advance(ms) {
  mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

async function setup() {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const host = makeHost();
  // Stats live in module scope and survive onunload (they are persisted on
  // purpose). Seeding empty stats keeps each test independent of the previous.
  host.pluginData.set(
    "stats.json",
    JSON.stringify({ incidents: 0, retriesSent: 0, retriesSkipped: 0, breakerTrips: 0, history: [] }),
  );
  plugin.onload(host);
  // Let the config/stats reads settle before any test input.
  await new Promise((resolve) => setImmediate(resolve));
  return host;
}

function teardown() {
  plugin.onunload();
  mock.timers.reset();
}

test("sends the retry one minute after the capacity message", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  assert.equal(host.sent.length, 0, "must not send immediately");

  await advance(59_000);
  assert.equal(host.sent.length, 0, "must still wait at 59s");

  await advance(2_000);
  assert.deepEqual(host.sent, [{ sessionId: SESSION, text: "retry last request" }]);
});

test("shows a countdown ticker while the retry is pending", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(5_000);

  const countdown = host.tickers.filter((tk) => tk.text.includes("retry in"));
  assert.ok(countdown.length > 0, "expected a countdown ticker");
});

test("collapses repeated detections of one incident into a single retry", async (t) => {
  const host = await setup();
  t.after(teardown);

  // A TUI repaint re-emits the same warning line many times.
  for (let i = 0; i < 10; i++) emitLine(host, CAPACITY_LINE);
  await advance(61_000);

  assert.equal(host.sent.length, 1);
});

test("matches the warning when the terminal wraps the line", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, "  at capacity. Please try a different model.");
  await advance(61_000);

  assert.equal(host.sent.length, 1);
});

test("ignores unrelated output", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, "The queue is at capacity of 10 items");
  emitLine(host, "Selected model is gpt-5-codex");
  await advance(61_000);

  assert.equal(host.sent.length, 0);
});

test("allows 3 retries in the hour, then blocks on the 4th incident", async (t) => {
  const host = await setup();
  t.after(teardown);

  for (let i = 0; i < 3; i++) {
    emitLine(host, CAPACITY_LINE);
    await advance(61_000);
  }
  assert.equal(host.sent.length, 3, "first three incidents must retry");

  emitLine(host, CAPACITY_LINE);
  await advance(120_000);

  assert.equal(host.sent.length, 3, "fourth incident must not retry");
  assert.ok(
    host.items.has(`at-capacity-retry:blocked:${SESSION}`),
    "expected a blocked item in the Activity Center",
  );
  assert.deepEqual(host.sounds, ["warning"], "expected a warning sound");
});

test("retries again once the hour window has passed", async (t) => {
  const host = await setup();
  t.after(teardown);

  for (let i = 0; i < 3; i++) {
    emitLine(host, CAPACITY_LINE);
    await advance(61_000);
  }
  assert.equal(host.sent.length, 3);

  // Push the three retries out of the rolling window.
  await advance(60 * 60 * 1000);
  emitLine(host, CAPACITY_LINE);
  await advance(61_000);

  assert.equal(host.sent.length, 4, "budget must free up as the window rolls");
});

test("user input unblocks a blocked session and clears the hour budget", async (t) => {
  const host = await setup();
  t.after(teardown);

  for (let i = 0; i < 3; i++) {
    emitLine(host, CAPACITY_LINE);
    await advance(61_000);
  }
  emitLine(host, CAPACITY_LINE);
  await advance(1_000);
  assert.ok(host.items.has(`at-capacity-retry:blocked:${SESSION}`), "must be blocked first");

  emitEvent(host, "user-input", { content: "use another model" });
  assert.ok(
    !host.items.has(`at-capacity-retry:blocked:${SESSION}`),
    "user input must unblock the session",
  );

  emitLine(host, CAPACITY_LINE);
  await advance(61_000);
  assert.equal(host.sent.length, 4, "retries must resume after the human took over");
});

test("the echo of our own retry does not cancel the incident", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(30_000);
  // The backend reports our injected text back as user input.
  emitEvent(host, "user-input", { content: "retry last request" });
  await advance(31_000);

  assert.equal(host.sent.length, 1, "our own echo must not cancel the pending retry");
});

test("real user input cancels the pending retry", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(30_000);
  emitEvent(host, "user-input", { content: "switch to another model" });
  await advance(120_000);

  assert.equal(host.sent.length, 0, "the human took over — no retry");
});

test("skips the retry when the user has unsent text in the input box", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  host.inputBuffer = "half-typed question";
  await advance(61_000);

  assert.equal(host.sent.length, 0);
});

test("skips the retry when the agent resumed work by itself", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(10_000);
  emitEvent(host, "shell-state", { state: "busy" });
  await advance(51_000);

  assert.equal(host.sent.length, 0);
});

test("a busy state older than the detection does not suppress the retry", async (t) => {
  const host = await setup();
  t.after(teardown);

  // The at-capacity message arrives while the turn is still busy.
  emitEvent(host, "shell-state", { state: "busy" });
  await advance(1_000);
  emitLine(host, CAPACITY_LINE);
  await advance(61_000);

  assert.equal(host.sent.length, 1);
});

test("drops a retry that fires late because the machine slept", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  // Fake timers do not suspend, so the sleep is simulated by a single long tick:
  // the timer fires far past its due time, exactly as it does on resume.
  await advance(10 * 60 * 1000);

  assert.equal(host.sent.length, 0, "a stale incident must not be retried blindly");
});

test("session teardown cancels the pending retry", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(10_000);
  emitEvent(host, "session-closed", {});
  await advance(120_000);

  assert.equal(host.sent.length, 0);
});

test("tracks sessions independently", async (t) => {
  const host = await setup();
  t.after(teardown);
  const OTHER = "sess-abcdefghij";

  for (let i = 0; i < 3; i++) {
    emitLine(host, CAPACITY_LINE);
    await advance(61_000);
  }
  emitLine(host, CAPACITY_LINE);
  await advance(1_000);
  assert.ok(host.items.has(`at-capacity-retry:blocked:${SESSION}`), "first session blocked");

  emitLine(host, CAPACITY_LINE, OTHER);
  await advance(61_000);

  assert.ok(
    host.sent.some((s) => s.sessionId === OTHER),
    "a second session keeps its own budget",
  );
});

test("persists stats and renders them in the dashboard", async (t) => {
  const host = await setup();
  t.after(teardown);

  emitLine(host, CAPACITY_LINE);
  await advance(61_000);

  const raw = host.pluginData.get("stats.json");
  assert.ok(raw, "stats must be persisted");
  const saved = JSON.parse(raw);
  assert.equal(saved.retriesSent, 1);
  assert.equal(saved.incidents, 1);

  const md = host.markdownProvider.provideContent();
  assert.match(md, /# At-Capacity Retry/);
  assert.match(md, /\| Retries sent \| 1 \|/);
});

test("unload cancels every pending retry", async (t) => {
  const host = await setup();
  t.after(() => mock.timers.reset());

  emitLine(host, CAPACITY_LINE);
  plugin.onunload();
  await advance(120_000);

  assert.equal(host.sent.length, 0);
});
