import assert from "node:assert/strict";
import test from "node:test";

import plugin from "./main.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHost() {
  const host = {
    repoPath: "/repo",
    handlers: new Map(),
    stateHandlers: [],
    files: new Map(),
    directories: new Map(),
    opened: [],
    watches: [],
    logs: [],
    registerStructuredEventHandler(type, handler) { host.handlers.set(type, handler); },
    onStateChange(handler) { host.stateHandlers.push(handler); },
    getActiveRepoPath() { return host.repoPath; },
    getSessionCwd() { return "/repo"; },
    async listDirectory(path) { return host.directories.get(path) ?? []; },
    async readFile(path) {
      if (!host.files.has(path)) throw new Error("not found");
      return host.files.get(path);
    },
    async watchPath(path, callback) {
      const watch = { path, callback, disposed: false, dispose() { watch.disposed = true; } };
      host.watches.push(watch);
      return watch;
    },
    openMarkdownFileBackground(path) { host.opened.push(path); return true; },
    log(level, message) { host.logs.push({ level, message }); },
  };
  return host;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("opens a structured plan once in the background", async (t) => {
  const host = makeHost();
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();

  const handler = host.handlers.get("plan-file");
  handler({ path: "plans/feature.md" }, "session-1");
  handler({ path: "plans/feature.md" }, "session-1");

  assert.deepEqual(host.opened, ["/repo/plans/feature.md"]);
});

test("accepts a Windows UNC plan path", async (t) => {
  const host = makeHost();
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();

  host.handlers.get("plan-file")({ path: "\\\\server\\share\\plans\\feature.md" }, "session-1");

  assert.deepEqual(host.opened, ["\\\\server\\share\\plans\\feature.md"]);
});

test("opens the active plan marker without stealing focus", async (t) => {
  const host = makeHost();
  host.files.set("/repo/.claude/active-plan.json", JSON.stringify({ path: "plans/active.md" }));
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();

  assert.deepEqual(host.opened, ["/repo/plans/active.md"]);
});

test("disposes a stale watch created during a rapid repo switch", async (t) => {
  const host = makeHost();
  const pending = deferred();
  const stale = { disposed: false, dispose() { stale.disposed = true; } };
  const current = { disposed: false, dispose() { current.disposed = true; } };
  let call = 0;
  host.watchPath = () => {
    call += 1;
    return call === 1 ? pending.promise : Promise.resolve(current);
  };
  plugin.onload(host);
  t.after(() => plugin.onunload());

  host.repoPath = "/other";
  host.stateHandlers[0]({ type: "repo-changed" });
  pending.resolve(stale);
  await settle();

  assert.equal(stale.disposed, true);
  assert.equal(current.disposed, false);
});

test("does not reopen a closed active plan when the repo is re-entered", async (t) => {
  const host = makeHost();
  host.files.set("/repo/.claude/active-plan.json", JSON.stringify({ path: "plans/active.md" }));
  plugin.onload(host);
  t.after(() => plugin.onunload());
  await settle();
  assert.deepEqual(host.opened, ["/repo/plans/active.md"]);

  // The user closes the tab, leaves the repo and comes back.
  host.repoPath = "/other";
  host.stateHandlers[0]({ type: "repo-changed" });
  await settle();
  host.repoPath = "/repo";
  host.stateHandlers[0]({ type: "repo-changed" });
  await settle();

  assert.deepEqual(host.opened, ["/repo/plans/active.md"]);
});
