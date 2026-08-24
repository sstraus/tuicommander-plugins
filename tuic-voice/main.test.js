/**
 * Tests for the Voice plugin.
 *
 * Run: node --test tuic-voice/
 *
 * The plugin is driven through the surface the app gives it — a PluginHost double
 * plus a `speechSynthesis` double that records every utterance — because what is
 * under test is a chain of heuristics, and only the end of the chain is meaningful.
 * "Did the tool-call regex match" is not the property we care about; "was the tool
 * call spoken aloud" is.
 *
 * The screens below are synthetic but shaped like a real agent frame: prose at the
 * top, tool calls and results in the middle, then the separator / input box / status
 * line that the project rule says must never reach a parser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import plugin from "./main.js";

const SESSION = "sess-1";
const POLL_MS = 700;

/** Records utterances instead of speaking them. */
function installSpeechDouble() {
	const spoken = [];
	class FakeUtterance {
		constructor(text) {
			this.text = text;
		}
	}
	const synth = {
		speak(u) {
			spoken.push(u.text);
			// The real API fires onend asynchronously; firing it now keeps the
			// plugin's queue counter from saturating during a test.
			if (u.onend) queueMicrotask(() => u.onend());
		},
		cancel() {
			spoken.push("<cancel>");
		},
		getVoices() {
			return [{ voiceURI: "it-IT-Alice", name: "Alice", lang: "it_IT" }];
		},
	};
	globalThis.window = { speechSynthesis: synth };
	globalThis.speechSynthesis = synth;
	globalThis.SpeechSynthesisUtterance = FakeUtterance;
	return spoken;
}

/**
 * A PluginHost double. `screens` is the queue of screen contents
 * `readSessionOutput` hands back, one per call, the last one repeating.
 */
function makeHost(screens) {
	const state = { handlers: [], structured: new Map(), actions: new Map(), logs: [], reads: 0 };
	const host = {
		log: (level, message, data) => state.logs.push({ level, message, data }),
		invoke: async (cmd) => {
			if (cmd === "read_plugin_data") throw new Error("no config");
			return "";
		},
		readSessionOutput: async () => {
			const i = Math.min(state.reads, screens.length - 1);
			state.reads += 1;
			return screens[i];
		},
		registerStructuredEventHandler: (type, handler) => {
			state.structured.set(type, handler);
			return { dispose() {} };
		},
		registerTerminalAction: (a) => {
			state.actions.set(a.id, a);
			return { dispose() {} };
		},
		onStateChange: (cb) => {
			state.handlers.push(cb);
			return { dispose() {} };
		},
		openPanel: () => ({ tabId: "t", update: () => true, isVisible: () => true, close() {}, send() {} }),
	};
	return { host, state };
}

/** Let the plugin's async pump chain settle. */
async function settle() {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Flip the session busy/idle the way the backend's shell-state event does. */
async function shellState(state, value) {
	state.structured.get("shell-state")({ type: "shell-state", state: value }, SESSION);
	await settle();
}

/** A frame with prose, tool chrome, and the untouchable bottom zone. */
function frame(prose) {
	return [
		"⏺ Bash(cargo nextest run)",
		"  ⎿  running 412 tests",
		"     test result: ok. 412 passed",
		...prose,
		"",
		"╭─────────────────────────────────────────╮",
		"│ ❯                                       │",
		"╰─────────────────────────────────────────╯",
		"  [Opus 5 (1M) | Team] ██░░ 22% | 📚 8",
		"  5h: 0% | 7d: 2% | $15.48 | 📅 $136.41",
		"  ⏵⏵ bypass permissions on (shift+tab)",
	].join("\n");
}

test("speaks prose and no chrome", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Ho corretto il parser. I test passano."])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, ["Ho corretto il parser.", "I test passano."]);
	// Nothing from the tool call, the result gutter, the box, or the status line.
	for (const bad of ["cargo", "412", "bypass", "15.48", "22%", "❯"]) {
		assert.ok(!spoken.some((s) => s.includes(bad)), `spoke chrome containing "${bad}"`);
	}
});

test("does not re-speak a repainted line", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const screen = frame(["⏺ Il fix è pronto."]);
	const { host, state } = makeHost([frame([]), screen, screen, screen]);

	await plugin.onload(host);
	await shellState(state, "busy");
	for (let i = 0; i < 3; i++) {
		t.mock.timers.tick(POLL_MS);
		await settle();
	}

	assert.deepEqual(spoken, ["Il fix è pronto."]);
});

test("speaks sentence one while sentence two is still arriving", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([
		frame([]),
		// Turn in progress: first sentence complete, second still a fragment.
		frame(["⏺ Ho letto il file di configurazione.", "  Adesso sto"]),
		frame(["⏺ Ho letto il file di configurazione.", "  Adesso sto controllando i test."]),
	]);

	await plugin.onload(host);
	await shellState(state, "busy");

	t.mock.timers.tick(POLL_MS);
	await settle();
	assert.deepEqual(spoken, ["Ho letto il file di configurazione."], "first sentence must not wait");

	t.mock.timers.tick(POLL_MS);
	await settle();
	assert.deepEqual(spoken, ["Ho letto il file di configurazione.", "Adesso sto controllando i test."]);
});

// The growing tail line is the failure mode that line-dedup alone cannot see:
// each repaint extends it, so every repaint looks like a brand-new line.

test("a growing line that gains a second sentence speaks both, once", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([
		frame([]),
		frame(["⏺ Sto per"]),
		frame(["⏺ Sto per iniziare. Poi ti dico come è andata."]),
	]);

	await plugin.onload(host);
	await shellState(state, "busy");
	for (let i = 0; i < 2; i++) {
		t.mock.timers.tick(POLL_MS);
		await settle();
	}

	assert.deepEqual(spoken, ["Sto per iniziare.", "Poi ti dico come è andata."]);
});

test("a growing line still unterminated when the turn ends is spoken once, whole", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Sto"]), frame(["⏺ Sto ancora lavorando"])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();
	await shellState(state, "idle");

	assert.deepEqual(spoken, ["Sto ancora lavorando"]);
});

test("a line that grows while a later line is added keeps both in order", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([
		frame([]),
		frame(["⏺ Primo passo"]),
		frame(["⏺ Primo passo completato.", "  Secondo passo completato."]),
	]);

	await plugin.onload(host);
	await shellState(state, "busy");
	for (let i = 0; i < 2; i++) {
		t.mock.timers.tick(POLL_MS);
		await settle();
	}

	assert.deepEqual(spoken, ["Primo passo completato.", "Secondo passo completato."]);
});

test("does not read the backlog present when the turn starts", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const backlog = frame(["⏺ Questa è la risposta del turno precedente."]);
	const { host, state } = makeHost([backlog, backlog]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, []);
});

test("going idle flushes a sentence that never got its full stop", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Fatto, ho finito il lavoro richiesto"])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	await shellState(state, "idle");

	assert.deepEqual(spoken, ["Fatto, ho finito il lavoro richiesto"]);
});

test("a repeated busy mid-turn does not swallow unspoken prose", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Questa frase deve essere letta."])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	// A second busy without an intervening idle must NOT re-prime: priming marks
	// what is on screen as already seen, so re-priming mid-turn would silently
	// discard the sentence the agent just wrote.
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, ["Questa frase deve essere letta."]);
});

// A colon terminates a clause but not a sentence, so a short lead-in like "Ecco:"
// is never worth speaking alone. It used to be cut off and pushed back onto the
// buffer unchanged, which made the next pass cut it at the same place — an
// unbreakable spin on the WebView's only thread, i.e. the whole app frozen the
// moment the agent wrote a colon.

test("a short clause before a colon merges forward instead of spinning", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Ecco: ho finito il lavoro adesso."])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, ["Ecco: ho finito il lavoro adesso."]);
});

test("a colon with nothing after it waits, then flushes when the turn ends", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Riassunto:"])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();
	assert.deepEqual(spoken, [], "a bare lead-in must not be spoken alone");

	await shellState(state, "idle");
	assert.deepEqual(spoken, ["Riassunto:"]);
});

test("an abbreviation does not suppress the real sentence end after it", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([]), frame(["⏺ Un caso limite, e.g. quello del parser, è coperto."])]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, ["Un caso limite, e.g. quello del parser, è coperto."]);
});

test("drops diffs, code and bare paths", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([
		frame([]),
		frame([
			"⏺ Ecco la modifica.",
			"+   let cutoff = find_chrome_cutoff(rows);",
			"-   let cutoff = None;",
			"  src-tauri/src/pty.rs",
			"  if (a === b) { return c[0]; }",
			"  ```rust",
		]),
	]);

	await plugin.onload(host);
	await shellState(state, "busy");
	t.mock.timers.tick(POLL_MS);
	await settle();

	assert.deepEqual(spoken, ["Ecco la modifica."]);
});

test("stop cancels whatever is being spoken", async (t) => {
	const spoken = installSpeechDouble();
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => plugin.onunload());
	const { host, state } = makeHost([frame([])]);

	await plugin.onload(host);
	state.actions.get("voice-stop").action({ sessionId: SESSION, repoPath: null });

	assert.deepEqual(spoken, ["<cancel>"]);
});
