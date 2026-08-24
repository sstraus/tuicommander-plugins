/**
 * Tests for the Wiz Kanban plugin.
 *
 * Run: node --test wiz-kanban/
 *
 * The plugin is driven through the same surface the app gives it: a PluginHost
 * double that records the calls, plus the panel handle the host hands back from
 * openPanel(). Both properties under test are about work the plugin must NOT
 * do — rebuild a board nobody is looking at, and read story files one IPC at a
 * time — so the assertions count calls rather than inspect markup.
 */

import test from "node:test";
import assert from "node:assert/strict";

import plugin from "./main.js";

const REPO = "/repo";

/** Frontmatter the loaders accept, one story per file. */
function storyFile(seq) {
  return `---\nid: ${seq}-aaaa\ntitle: Story ${seq}\nstatus: ready\npriority: P2\n---\n\n## Work Log\n`;
}

/**
 * Minimal PluginHost double.
 *
 * `readFiles` is deliberately present: the batch read is the host API the
 * plugin is expected to use, and a double that only offered `readFile` would
 * make the N-IPC test unfalsifiable.
 */
function makeHost(fileCount) {
  const files = Array.from({ length: fileCount }, (_, i) => `${i + 1}-aaaa-ready-P2-story.md`);
  const host = {
    files,
    actions: [],
    panels: [],
    watchers: [],
    stateHandlers: [],
    readFileCalls: [],
    readFilesCalls: [],

    log() {},
    registerTerminalAction(action) {
      host.actions.push(action);
    },
    onStateChange(handler) {
      host.stateHandlers.push(handler);
    },
    /** Drive the same state event the app emits when the user switches repo. */
    emitState(event) {
      for (const handler of host.stateHandlers) handler(event);
    },
    getActiveRepo() {
      return { path: REPO, name: "repo" };
    },
    async listDirectory() {
      return files;
    },
    async readFile(path) {
      host.readFileCalls.push(path);
      return storyFile(1);
    },
    async readFiles(paths) {
      host.readFilesCalls.push(paths);
      // Derive the content from the path, not the index: a chunked read must
      // still hand every file its own body.
      return paths.map((path) => storyFile(Number.parseInt(path.split("/").pop(), 10)));
    },
    openPanel(options) {
      const existing = host.panels[0];
      if (existing) {
        // The host reuses a panel with the same id and brings it to the front.
        existing.options = options;
        existing.reopened = (existing.reopened ?? 0) + 1;
        existing.visible = true;
        return existing;
      }
      const panel = {
        options,
        updates: [],
        reopened: 0,
        visible: true,
        closed: false,
        update(html) {
          // A closed tab reports itself dead instead of swallowing the write.
          if (panel.closed) return false;
          panel.updates.push(html);
          return true;
        },
        isVisible() {
          // A closed panel is not visible — the registry drops its state.
          return panel.visible && !panel.closed;
        },
        send() {},
        close() {},
        /** Close the tab from the tab bar, behind the plugin's back. */
        closeFromTabBar() {
          panel.closed = true;
          options.onClose?.();
        },
        /** Flip visibility the way PluginPanel does when the tab is switched. */
        setVisible(visible) {
          if (panel.visible === visible) return;
          panel.visible = visible;
          options.onVisibilityChange?.(visible);
        },
      };
      host.panels.push(panel);
      return panel;
    },
    async watchPath(path, callback) {
      const watcher = { path, callback, disposed: false };
      host.watchers.push(watcher);
      return {
        dispose() {
          watcher.disposed = true;
        },
      };
    },
  };
  return host;
}

/** Let every pending promise chain settle without waiting on real timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Open the board through the terminal action the plugin registers. */
async function openBoard(host) {
  plugin.onload(host);
  await host.actions.find((a) => a.id === "open-kanban").action();
  return host.panels[0];
}

test("reads every story file in one batch call", async (t) => {
  const host = makeHost(25);
  t.after(() => plugin.onunload());

  await openBoard(host);

  assert.equal(host.readFileCalls.length, 0, "no per-file read should be issued");
  assert.equal(host.readFilesCalls.length, 1, "the 25 files should cost one call");
  assert.equal(host.readFilesCalls[0].length, 25);
  assert.equal(host.readFilesCalls[0][0], `${REPO}/stories/${host.files[0]}`);
});

test("does not rebuild the board while the panel is hidden", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];
  assert.ok(watcher, "the plugin should watch the stories directory");

  panel.setVisible(false);
  host.readFilesCalls.length = 0;

  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  assert.equal(panel.updates.length, 0, "a hidden panel must not be re-rendered");
  assert.equal(host.readFilesCalls.length, 0, "a hidden panel must not re-read the files");
});

test("rebuilds once when the panel becomes visible again", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  panel.setVisible(false);
  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  panel.setVisible(true);
  await flush();

  assert.equal(panel.updates.length, 1, "the change missed while hidden should land on re-show");
});

test("chunks a directory larger than the host's batch limit", async (t) => {
  const host = makeHost(1200);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);

  // The host rejects a request above its limit outright, so the plugin must
  // chunk rather than hand it the whole directory and render an empty board.
  assert.ok(host.readFilesCalls.length > 1, "1200 files should be split into chunks");
  assert.ok(host.readFilesCalls.length < 20, "chunking must stay far from one call per file");
  for (const call of host.readFilesCalls) {
    assert.ok(call.length <= 1000, `a chunk of ${call.length} exceeds the host limit`);
  }
  assert.equal(
    host.readFilesCalls.reduce((n, call) => n + call.length, 0),
    1200,
    "every file should still be read",
  );
  assert.ok(panel.options.html.includes("Story 1200"), "the last story should reach the board");
});

test("does not rebuild a hidden board when the repo changes", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  panel.setVisible(false);
  host.readFilesCalls.length = 0;

  host.emitState({ type: "repo-changed" });
  await flush();

  assert.equal(panel.reopened, 0, "a hidden panel must not be reopened and refocused");
  assert.equal(host.readFilesCalls.length, 0, "a hidden panel must not re-read the files");

  panel.setVisible(true);
  await flush();
  assert.equal(panel.updates.length, 1, "the repo change should land when the panel returns");
});

test("stops watching when the panel is closed from the tab bar", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  panel.closeFromTabBar();
  await flush();

  assert.equal(watcher.disposed, true, "a closed board must release its filesystem watch");

  // The handle is dead: a later repo change must not resurrect the panel.
  host.emitState({ type: "repo-changed" });
  await flush();
  assert.equal(panel.reopened, 0, "a closed board must not reopen itself");
});

test("does not write into a panel hidden while the render was in flight", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);
  const watcher = host.watchers[0];

  // Hide the panel mid-render: the visibility check before the await is not
  // enough on its own.
  const listDirectory = host.listDirectory;
  host.listDirectory = async (...args) => {
    panel.setVisible(false);
    return listDirectory.apply(host, args);
  };

  watcher.callback();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await flush();

  assert.equal(panel.updates.length, 0, "the panel went hidden before the write landed");
});

test("does not rebuild on re-show when nothing changed while hidden", async (t) => {
  const host = makeHost(3);
  t.after(() => plugin.onunload());

  const panel = await openBoard(host);

  panel.setVisible(false);
  await flush();
  panel.setVisible(true);
  await flush();

  assert.equal(panel.updates.length, 0, "no watch event means no work to catch up on");
});
