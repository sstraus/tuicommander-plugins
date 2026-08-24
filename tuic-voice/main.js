/**
 * TUICommander Voice — reads an agent's prose aloud while it streams.
 *
 * Speech comes from the WebView's own Web Speech API (`speechSynthesis`), so the
 * plugin ships no model, no binary and no download. On a remote/browser client it
 * speaks on the machine the human is sitting at, which is the only place that is
 * ever correct.
 *
 * The hard part is not speaking, it is deciding WHAT to speak.
 *
 * An agent TUI is a repainting screen, not a stream of prose. `registerOutputWatcher`
 * receives raw PTY lines, which for an Ink/alternate-screen agent means the same
 * paragraph retransmitted dozens of times as it grows, interleaved with cursor moves
 * and Kitty graphics escapes. So this plugin reads the DECODED SCREEN instead
 * (`host.readSessionOutput`), on a timer, and works out what is new since last look:
 *
 *   screen -> chrome cutoff -> per-line filter -> dedup -> sentence segmenter -> speak
 *
 * Each stage is separately tunable because each one is a heuristic that a new agent
 * release can invalidate. When speech reads something it should not have, find the
 * stage that let it through — `debugFilter` logs the rule that fired for every
 * dropped line.
 */

const PLUGIN_ID = "tuic-voice";
const DATA_FILE = "config.json";
const PANEL_ID = "voice-settings";

/** How often we re-read the screen while an agent is working. */
const POLL_MS = 700;
/** Screen lines requested per poll. The visible screen is what matters; scrollback
 *  is empty for alternate-screen agents anyway. */
const READ_LINES = 120;
/** Hard cut for a spoken chunk. Long utterances stall in WebKit and cannot be
 *  interrupted cleanly. */
const MAX_CHUNK = 240;
/** Below this, a fragment waits for more text rather than being spoken alone —
 *  unless the agent has stopped, which flushes whatever is left. */
const MIN_CHUNK = 24;
/** Lines remembered for dedup. A repaint resends identical lines; without this the
 *  same sentence is spoken on every poll. */
const DEDUP_CAPACITY = 600;
/** If the speech queue falls this far behind, stop enqueuing: the agent is producing
 *  faster than any voice can read, and a 4-minute backlog is worse than silence. */
const MAX_QUEUE = 12;

// ── Line classification ────────────────────────────────────────────────────
//
// Anchors the bottom of the readable area. Deliberately narrow: a bare ">" also
// starts a markdown blockquote, and matching that would cut the agent's own prose.

const PROMPT_RE = /^\s*[│┃]?\s*(?:❯|›|▶)\s?/;
const BORDER_RE = /^[\s╭╮╰╯┌┐└┘─━═▁▔│┃▏▕]{8,}$/;

/**
 * Every rule that removes a line, in order. Named so a wrong drop is traceable
 * instead of mysterious.
 */
const DROP_RULES = [
	// A tool invocation: bullet, CapitalisedName, open paren. `⏺ Sto per fare X`
	// is prose and survives; `⏺ Bash(cargo test)` does not.
	{ name: "tool-call", re: /^\s*[⏺●○]\s+[A-Z][A-Za-z0-9_]*\(/ },
	// Tool result / continuation gutter.
	{ name: "tool-result", re: /^\s*[⎿└├]/ },
	// Agent chrome: hook lines, permission footers, mode switches.
	{ name: "agent-chrome", re: /^\s*(?:[◆◇◐◑✓✗✔✘×]|⏵⏵|\?\s+for shortcuts)/ },
	// Spinner / token counter. The glyph alone is not enough — prose can start with
	// a bullet — so require the parenthesised timing that always follows it.
	{ name: "spinner", re: /^\s*[✻✽✢✳*·]\s+\S+.*\((?:[\dhms.\s·↓↑]+|.*tokens?.*)\)/ },
	// Status-line / HUD residue, in case the chrome cutoff found no anchor.
	{ name: "hud", re: /(?:↓\s*[\d.]+k?\s*tokens?|\$\d+[.,]\d{2}|\b\d{1,3}%\s*\|)/ },
	// Unified diff.
	{ name: "diff", re: /^\s*(?:[+-]{1}(?![+-])|\d+\s*[+-]\s)/ },
	// Shell prompt echo or a bare command line.
	{ name: "command", re: /^\s*[$#]\s+\S/ },
	// A path or a URL on its own line reads as gibberish.
	{ name: "bare-path", re: /^\s*(?:[a-z]+:\/\/|[~/]|[\w.-]+\/)\S*\s*$/i },
	// Table / box row.
	{ name: "table", re: /^\s*\|.*\|\s*$/ },
	// Markdown fence and heading markers carry no speech.
	{ name: "fence", re: /^\s*(?:```|~~~)/ },
];

/** Characters that mean "this line is drawing, not saying". */
const BOX_CHARS = /[─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▁▔█░▒▓▏▕]/g;

/**
 * Find the first row of the input-box chrome. Everything from there down is the
 * user's own configured status line, the input box and the agent's footer — none
 * of it is the agent talking.
 *
 * Returns `lines.length` when no anchor is found. That fails OPEN on purpose: the
 * per-line filters below are the second line of defence, and cutting on a guess
 * would silently swallow the agent's last paragraph, which is the one the human
 * most wants to hear.
 */
function chromeCutoff(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!PROMPT_RE.test(lines[i])) continue;
		let cut = i;
		// Extend upward across the box's top border and its padding.
		for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
			const raw = lines[j];
			if (raw.trim() === "" || BORDER_RE.test(raw)) cut = j;
			else break;
		}
		return cut;
	}
	return lines.length;
}

/** Ratio of box-drawing characters — a cheap "is this a frame?" test. */
function boxRatio(line) {
	const trimmed = line.trim();
	if (!trimmed) return 1;
	const drawn = (trimmed.match(BOX_CHARS) || []).length;
	return drawn / trimmed.length;
}

/**
 * Reduce one screen line to speakable prose, or null.
 * `onDrop(rule)` is called with the name of the rule that rejected it.
 */
function proseOf(line, onDrop) {
	if (!line.trim()) return null;
	if (boxRatio(line) > 0.3) {
		onDrop("box-drawing");
		return null;
	}
	for (const rule of DROP_RULES) {
		if (rule.re.test(line)) {
			onDrop(rule.name);
			return null;
		}
	}
	// Strip the assistant's message bullet and the left gutter, keep the sentence.
	const text = line
		.replace(/^\s*[⏺●○]\s+/, "")
		.replace(/^\s*[│┃]\s?/, "")
		.trim();
	if (!text) return null;
	// A line with no letters is punctuation art, not speech.
	if (!/\p{L}/u.test(text)) {
		onDrop("no-letters");
		return null;
	}
	// Dense punctuation with no sentence ending is code, not a sentence.
	const symbols = (text.match(/[{}()[\];=<>|&*`]/g) || []).length;
	if (symbols >= 4 && !/[.!?…]\s*$/.test(text)) {
		onDrop("code-like");
		return null;
	}
	return text;
}

// ── Sentence segmentation ──────────────────────────────────────────────────

/**
 * Accumulates prose and hands back complete utterances as soon as they are
 * complete — the whole point of the exercise is to start speaking paragraph one
 * while the agent is still writing paragraph two.
 */
function createSegmenter() {
	let buffer = "";
	return {
		push(text) {
			// The last line of a streaming reply GROWS between repaints: first
			// "Adesso sto", then "Adesso sto controllando i test." Those are two
			// different strings, so line dedup cannot see them as one line — it lets
			// both through and the naive append says "Adesso sto Adesso sto
			// controllando i test." The buffer only ever holds the un-terminated
			// tail, which is precisely that growing line, so an incoming text that
			// extends it REPLACES it instead of following it.
			if (buffer && text.startsWith(buffer)) {
				buffer = text;
				return;
			}
			buffer = buffer ? `${buffer} ${text}` : text;
		},
		/** Complete sentences available now. */
		drain() {
			const out = [];
			for (;;) {
				const cut = utteranceEnd(buffer);
				// Nothing complete enough to say yet — leave the buffer untouched and
				// wait for the next repaint. Consuming a fragment here and putting it
				// back is what used to spin the thread forever: the next pass cut it
				// at exactly the same place.
				if (cut < 0) break;
				const chunk = buffer.slice(0, cut).trim();
				buffer = buffer.slice(cut).trim();
				if (chunk) out.push(chunk);
				if (buffer.length === 0) break;
			}
			// A paragraph with no terminator would otherwise never be spoken.
			while (buffer.length > MAX_CHUNK) {
				const space = buffer.lastIndexOf(" ", MAX_CHUNK);
				const cut = space > MIN_CHUNK ? space : MAX_CHUNK;
				out.push(buffer.slice(0, cut).trim());
				buffer = buffer.slice(cut).trim();
			}
			return out;
		},
		/** Everything left, spoken or not — used when the agent stops. */
		flush() {
			const rest = buffer.trim();
			buffer = "";
			return rest ? [rest] : [];
		},
		pending() {
			return buffer.length;
		},
	};
}

/**
 * Index just past the first sentence terminator at or after `from`, or -1.
 *
 * A false terminator SKIPS to the next candidate rather than abandoning the
 * search: "e.g." early in a paragraph must not hide the full stop that ends it.
 */
function sentenceEnd(text, from = 0) {
	const re = /[.!?…:](?=\s|$)/g;
	re.lastIndex = from;
	// A one-character match always advances lastIndex, so this cannot spin.
	for (let m = re.exec(text); m; m = re.exec(text)) {
		// "e.g." / "1." / "v1.2" are not sentence ends.
		const before = text.slice(Math.max(0, m.index - 3), m.index);
		// A ONE-LETTER token before the dot is an abbreviation or an initial. The
		// preceding character must be checked: without it "limite." qualifies too.
		if (m[0] === "." && /(?:^|[\s.])[a-z]$/i.test(before)) continue;
		if (m[0] === "." && /\d$/.test(before) && /^\s*\d/.test(text.slice(m.index + 1))) continue;
		return m.index + 1;
	}
	return -1;
}

/** Is this chunk worth speaking on its own? */
function speakable(chunk) {
	return chunk.length >= MIN_CHUNK || /[.!?…]$/.test(chunk);
}

/**
 * Index just past the first terminator that ends something worth SAYING, or -1.
 *
 * A colon ends a clause, not a thought: "Ecco:" alone is noise. So the scan keeps
 * extending past terminators until the accumulated text stands on its own — the
 * short lead-in merges FORWARD into the sentence it introduces. Returning -1 when
 * nothing qualifies is what keeps the caller's loop finite: the buffer is only ever
 * consumed, never rewritten.
 */
function utteranceEnd(text) {
	let cut = -1;
	for (;;) {
		const next = sentenceEnd(text, cut < 0 ? 0 : cut);
		if (next < 0) return -1;
		cut = next;
		if (speakable(text.slice(0, cut).trim())) return cut;
	}
}

// ── Speech ─────────────────────────────────────────────────────────────────

function createVoice(log) {
	const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
	let queued = 0;

	return {
		available() {
			return Boolean(synth);
		},
		voices() {
			return synth ? synth.getVoices() : [];
		},
		queueDepth() {
			return queued;
		},
		speak(text, config) {
			if (!synth) return false;
			if (queued >= MAX_QUEUE) {
				log("warn", "Speech queue full, dropping text", { queued, dropped: text.slice(0, 60) });
				return false;
			}
			const u = new SpeechSynthesisUtterance(text);
			const voice = config.voiceURI && synth.getVoices().find((v) => v.voiceURI === config.voiceURI);
			if (voice) u.voice = voice;
			if (config.lang) u.lang = config.lang;
			u.rate = config.rate;
			u.pitch = config.pitch;
			u.volume = config.volume;
			queued += 1;
			const done = () => {
				queued = Math.max(0, queued - 1);
			};
			u.onend = done;
			u.onerror = (e) => {
				done();
				// "interrupted" is what cancel() produces; it is not a failure.
				if (e && e.error && e.error !== "interrupted" && e.error !== "canceled") {
					log("warn", "Speech error", String(e.error));
				}
			};
			synth.speak(u);
			return true;
		},
		stop() {
			if (!synth) return;
			synth.cancel();
			queued = 0;
		},
	};
}

// ── Plugin ─────────────────────────────────────────────────────────────────

function defaultConfig() {
	return {
		enabled: true,
		/** Empty = whatever the WebView picks for the utterance language. */
		voiceURI: "",
		lang: "",
		rate: 1.15,
		pitch: 1,
		volume: 1,
		/** Log every dropped line and the rule that dropped it. Noisy by design. */
		debugFilter: false,
	};
}

let hostRef = null;
let config = defaultConfig();
let voice = null;
let panelHandle = null;
let timer = null;
/** sessionId -> {segmenter, seen:Set, order:string[]} */
const readers = new Map();
/** Sessions whose agent is currently running. */
const active = new Set();

function log(level, message, data) {
	if (hostRef) hostRef.log(level, message, data);
}

function readerFor(sessionId) {
	let r = readers.get(sessionId);
	if (!r) {
		r = { segmenter: createSegmenter(), seen: new Set(), order: [] };
		readers.set(sessionId, r);
	}
	return r;
}

/** Remember a line as spoken, evicting the oldest once we are at capacity. */
function remember(reader, key) {
	reader.seen.add(key);
	reader.order.push(key);
	if (reader.order.length > DEDUP_CAPACITY) {
		reader.seen.delete(reader.order.shift());
	}
}

/**
 * Read one session's screen and speak whatever prose is new.
 * `flushTail` speaks the trailing fragment too — used when the agent stops, where
 * there will be no further text to complete the sentence.
 */
async function pump(sessionId, flushTail) {
	const reader = readerFor(sessionId);
	let screen;
	try {
		screen = await hostRef.readSessionOutput(sessionId, READ_LINES);
	} catch (err) {
		log("warn", "readSessionOutput failed", String(err));
		return;
	}
	if (!screen) return;

	const lines = screen.split("\n");
	const cutoff = chromeCutoff(lines);
	const onDrop = config.debugFilter
		? (rule) => log("debug", `filter drop [${rule}]`)
		: () => {};

	for (let i = 0; i < cutoff; i++) {
		const text = proseOf(lines[i], onDrop);
		if (!text) continue;
		// A repaint resends the same line; normalise whitespace so a re-wrap at a
		// different column still counts as the same line.
		const key = text.replace(/\s+/g, " ");
		if (reader.seen.has(key)) continue;
		remember(reader, key);
		reader.segmenter.push(text);
	}

	const chunks = flushTail
		? reader.segmenter.drain().concat(reader.segmenter.flush())
		: reader.segmenter.drain();
	for (const chunk of chunks) voice.speak(chunk, config);
}

/**
 * Prime a session without speaking: everything already on screen when the agent
 * starts is backlog, and reading a whole previous turn aloud is the fastest way to
 * make someone uninstall this.
 */
async function prime(sessionId) {
	const reader = readerFor(sessionId);
	reader.segmenter.flush();
	try {
		const screen = await hostRef.readSessionOutput(sessionId, READ_LINES);
		if (!screen) return;
		const lines = screen.split("\n");
		const cutoff = chromeCutoff(lines);
		for (let i = 0; i < cutoff; i++) {
			const text = proseOf(lines[i], () => {});
			if (text) remember(reader, text.replace(/\s+/g, " "));
		}
	} catch (err) {
		log("warn", "Failed to prime session", String(err));
	}
}

function startTimer() {
	if (timer !== null) return;
	timer = setInterval(() => {
		if (!config.enabled || active.size === 0) return;
		for (const sessionId of active) {
			pump(sessionId, false).catch((err) => log("error", "pump failed", String(err)));
		}
	}, POLL_MS);
}

function stopTimer() {
	if (timer === null) return;
	clearInterval(timer);
	timer = null;
}

// ── Settings panel ─────────────────────────────────────────────────────────

function settingsHtml() {
	const voices = voice.voices();
	const options = voices
		.map(
			(v) =>
				`<option value="${escapeHtml(v.voiceURI)}"${v.voiceURI === config.voiceURI ? " selected" : ""}>${escapeHtml(v.name)} — ${escapeHtml(v.lang)}</option>`,
		)
		.join("");
	return `<div class="dashboard">
  <div class="dash-header"><h1 class="dash-title">Voice</h1>
    <div class="dash-subtitle">${voices.length} voices available${voice.available() ? "" : " — speechSynthesis unavailable in this WebView"}</div>
  </div>
  <div class="dash-section">
    <h2 class="dash-section-title">Output</h2>
    <label><input type="checkbox" id="enabled"${config.enabled ? " checked" : ""}> Speak agent replies</label>
    <label>Voice <select id="voiceURI"><option value="">Automatic</option>${options}</select></label>
    <label>Rate <input type="range" id="rate" min="0.5" max="2" step="0.05" value="${config.rate}"> <span id="rateVal">${config.rate}</span></label>
    <label>Pitch <input type="range" id="pitch" min="0.5" max="2" step="0.05" value="${config.pitch}"> <span id="pitchVal">${config.pitch}</span></label>
    <label>Volume <input type="range" id="volume" min="0" max="1" step="0.05" value="${config.volume}"> <span id="volVal">${config.volume}</span></label>
  </div>
  <div class="dash-section">
    <h2 class="dash-section-title">Diagnostics</h2>
    <label><input type="checkbox" id="debugFilter"${config.debugFilter ? " checked" : ""}> Log every dropped line and the rule that dropped it</label>
  </div>
  <div class="dash-section">
    <button id="test">Test voice</button>
    <button id="stop">Stop speaking</button>
    <button id="save">Save</button>
  </div>
<script>
  const post = (m) => window.parent.postMessage(m, "*");
  const val = (id) => document.getElementById(id);
  for (const id of ["rate","pitch","volume"]) {
    val(id).addEventListener("input", () => {
      const label = { rate: "rateVal", pitch: "pitchVal", volume: "volVal" }[id];
      val(label).textContent = val(id).value;
    });
  }
  val("save").addEventListener("click", () => post({ action: "save", config: {
    enabled: val("enabled").checked,
    voiceURI: val("voiceURI").value,
    rate: parseFloat(val("rate").value),
    pitch: parseFloat(val("pitch").value),
    volume: parseFloat(val("volume").value),
    debugFilter: val("debugFilter").checked,
  }}));
  val("test").addEventListener("click", () => post({ action: "test" }));
  val("stop").addEventListener("click", () => post({ action: "stop" }));
<\/script>
</div>`;
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

async function loadConfig() {
	try {
		const raw = await hostRef.invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: DATA_FILE });
		const saved = JSON.parse(raw);
		config = { ...defaultConfig(), ...saved };
	} catch {
		config = defaultConfig();
	}
}

async function saveConfig() {
	await hostRef.invoke("write_plugin_data", {
		pluginId: PLUGIN_ID,
		path: DATA_FILE,
		content: JSON.stringify(config, null, 2),
	});
}

function openSettings() {
	panelHandle = hostRef.openPanel({
		id: PANEL_ID,
		title: "Voice",
		html: settingsHtml(),
		onMessage: (msg) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.action === "save") {
				config = { ...config, ...msg.config };
				saveConfig()
					.then(() => log("info", "Voice settings saved", config))
					.catch((err) => log("error", "Failed to save settings", String(err)));
				if (!config.enabled) voice.stop();
			} else if (msg.action === "test") {
				voice.speak("Ciao Boss, la voce funziona.", config);
			} else if (msg.action === "stop") {
				voice.stop();
			}
		},
		onClose: () => {
			panelHandle = null;
		},
	});
}

export default {
	id: PLUGIN_ID,

	async onload(host) {
		hostRef = host;
		voice = createVoice(log);
		await loadConfig();

		if (!voice.available()) {
			log("error", "speechSynthesis is not available in this WebView — Voice cannot speak");
		} else {
			// getVoices() is async-populated in WebKit; the first call often returns [].
			const report = () => log("info", "Voice ready", { voices: voice.voices().length });
			report();
			if (typeof speechSynthesis !== "undefined" && "onvoiceschanged" in speechSynthesis) {
				speechSynthesis.onvoiceschanged = report;
			}
		}

		host.registerTerminalAction({
			id: "voice-stop",
			label: "Voice: stop speaking",
			action: () => voice.stop(),
		});
		host.registerTerminalAction({
			id: "voice-toggle",
			label: "Voice: toggle",
			action: () => {
				config.enabled = !config.enabled;
				if (!config.enabled) voice.stop();
				saveConfig().catch(() => {});
				log("info", `Voice ${config.enabled ? "enabled" : "disabled"}`);
			},
		});
		host.registerTerminalAction({
			id: "voice-settings",
			label: "Voice: settings",
			action: () => openSettings(),
		});

		// `shell-state` is the per-TURN boundary: the backend flips a session to
		// "busy" when the agent starts producing and back to "idle" when it stops.
		//
		// The tempting `onStateChange` events are NOT this. agent-started/-stopped
		// track which agent BINARY is running in the tab — they fire once when
		// Claude launches and once when it exits or is swapped for Codex. Driving
		// the reader off those would poll every 700 ms for the entire life of the
		// session and never flush a turn's closing sentence.
		host.registerStructuredEventHandler("shell-state", (payload, sessionId) => {
			if (!sessionId || !payload || typeof payload !== "object") return;
			if (payload.state === "idle") {
				if (!active.delete(sessionId)) return;
				// One last read: the closing sentence usually lands in the same repaint
				// that ends the turn, and without this it is never spoken.
				if (config.enabled) pump(sessionId, true).catch(() => {});
				if (active.size === 0) stopTimer();
			} else if (payload.state === "busy") {
				// Guard the edge. A second "busy" mid-turn would re-prime and mark
				// prose we have not spoken yet as already seen — silent data loss.
				if (active.has(sessionId)) return;
				// Prime before the first pump so the previous turn is not read out.
				prime(sessionId)
					.then(() => {
						active.add(sessionId);
						startTimer();
					})
					.catch(() => {});
			}
		});

		// The agent binary changed or exited: its screen conventions and its whole
		// dedup history are now meaningless.
		host.onStateChange((event) => {
			if (event.type !== "agent-stopped" || !event.sessionId) return;
			active.delete(event.sessionId);
			readers.delete(event.sessionId);
			if (active.size === 0) stopTimer();
		});

		log("info", "Voice loaded", { enabled: config.enabled });
	},

	onunload() {
		stopTimer();
		if (voice) voice.stop();
		readers.clear();
		active.clear();
		panelHandle = null;
		hostRef = null;
		voice = null;
		config = defaultConfig();
	},
};
