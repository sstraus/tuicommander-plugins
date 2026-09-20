import assert from "node:assert/strict";
import test from "node:test";
import plugin, {
	MAX_DATABASE_BYTES,
	absolutePath,
	arrayBufferToBase64,
	assetUrls,
	base64ToArrayBuffer,
	buildPanelHtml,
	buildFatalHtml,
	buildLoadingHtml,
	openDatabase,
	panelId,
} from "./main.js";

const runtime = {
	loaderSource: "window.initSqlJs = async () => ({ Database: class {} });",
	panelSource: "window.parent.postMessage({type:'sqlite-viewer-ready'}, '*');",
	wasmBuffer: new ArrayBuffer(8),
};

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function hostDouble(readResult = Promise.resolve("U1FMaXRlIGZvcm1hdCAzAA==")) {
	const state = { preview: null, options: null, sends: [], readCalls: [], writeCalls: [] };
	const panel = {
		send(data, transfer) {
			state.sends.push({ data, transfer });
		},
		close() {},
		update() {
			return true;
		},
		isVisible() {
			return true;
		},
	};
	const host = {
		registerFilePreview(options) {
			state.preview = options;
		},
		openPanel(options) {
			state.options = options;
			return panel;
		},
		readFileBase64(path, options) {
			state.readCalls.push({ path, options });
			return readResult;
		},
		async writeFileBase64(path, content, options) {
			state.writeCalls.push({ path, content, options });
		},
	};
	return { host, state };
}

test("registers the SQLite file extensions as a plugin preview", () => {
	const { host, state } = hostDouble();
	plugin.onload(host);
	assert.deepEqual(state.preview.extensions, ["db", "sqlite", "sqlite3", "db3", "s3db"]);
});

test("transfers database and WebAssembly ownership only after the iframe is ready", async () => {
	const { host, state } = hostDouble();
	const opened = openDatabase(host, { fsRoot: "/repo", filePath: "data/app.sqlite", repoPath: "/repo" }, async () => runtime);
	await Promise.resolve();
	assert.deepEqual(state.readCalls, [
		{ path: "/repo/data/app.sqlite", options: { maxBytes: MAX_DATABASE_BYTES } },
	]);
	assert.equal(state.sends.length, 0);

	state.options.onMessage({ type: "sqlite-viewer-ready" });
	await opened;

	assert.equal(state.sends.length, 1);
	const [{ data, transfer }] = state.sends;
	assert.equal(data.type, "load-database");
	assert.equal(data.databaseBuffer, transfer[0]);
	assert.equal(data.wasmBuffer, transfer[1]);
	assert.equal(transfer[0] instanceof ArrayBuffer, true);
	assert.equal(transfer[1] instanceof ArrayBuffer, true);
});

test("closing the tab drops a pending database load", async () => {
	const read = deferred();
	const { host, state } = hostDouble(read.promise);
	let assetSignal;
	const opening = openDatabase(
		host,
		{ fsRoot: "/repo", filePath: "data/app.db", repoPath: "/repo" },
		async (_assets, signal) => {
			assetSignal = signal;
			return runtime;
		},
	);
	state.options.onClose();
	state.options.onMessage({ type: "sqlite-viewer-ready" });
	read.resolve("U1FMaXRlIGZvcm1hdCAzAA==");
	await opening;

	assert.equal(assetSignal.aborted, true);
	assert.equal(state.sends.length, 0);
});

test("reports load failures through the ready panel", async () => {
	const { host, state } = hostDouble(Promise.reject(new Error("File exceeds maximum size")));
	await openDatabase(host, { fsRoot: "/repo", filePath: "huge.db", repoPath: "/repo" }, async () => runtime);
	state.options.onMessage({ type: "sqlite-viewer-ready" });

	assert.equal(state.sends[0].data.type, "load-error");
	assert.match(state.sends[0].data.message, /256 MiB/);
});

test("persists an exported database and acknowledges the iframe", async () => {
	const { host, state } = hostDouble();
	await openDatabase(host, { fsRoot: "/repo", filePath: "data/app.db", repoPath: "/repo" }, async () => runtime);
	state.options.onMessage({ type: "sqlite-viewer-ready" });
	state.sends.length = 0;
	state.options.onMessage({ type: "save-database", requestId: 7, buffer: new Uint8Array([0, 1, 2]).buffer });
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(state.writeCalls, [
		{ path: "/repo/data/app.db", content: "AAEC", options: { maxBytes: MAX_DATABASE_BYTES } },
	]);
	assert.deepEqual(state.sends, [{ data: { type: "save-result", requestId: 7, ok: true }, transfer: undefined }]);
});

test("builds escaped self-contained panel scripts", () => {
	const assets = assetUrls("plugin://sqlite-viewer/main.js");
	const html = buildPanelHtml('unsafe<".db', "window.loader = '</script>';", "window.panel = true;");
	assert.equal(assets.wasm, "plugin://sqlite-viewer/vendor/sql-wasm.wasm");
	assert.match(html, /window\.loader/);
	assert.match(html, /<\\\/script>/);
	assert.doesNotMatch(html, /unsafe<"\.db/);
	assert.ok(html.indexOf('id="objects"') < html.indexOf("window.panel = true"));
	assert.match(html, /\[hidden\] \{ display: none !important; \}/);
	assert.doesNotMatch(html, />Engine</);
	assert.match(buildLoadingHtml("app.db"), /Loading SQLite WebAssembly/);
	assert.match(buildFatalHtml("app.db", "bad < db"), /bad &lt; db/);
});

test("path, panel id, and Base64 helpers are deterministic", () => {
	assert.equal(absolutePath("/repo", "data/app.db"), "/repo/data/app.db");
	assert.equal(absolutePath("C:\\repo", "data\\app.db"), "C:\\repo\\data\\app.db");
	assert.equal(panelId("/a.db"), panelId("/a.db"));
	assert.notEqual(panelId("/a.db"), panelId("/b.db"));
	assert.deepEqual([...new Uint8Array(base64ToArrayBuffer("AAEC"))], [0, 1, 2]);
	assert.equal(arrayBufferToBase64(new Uint8Array([0, 1, 2]).buffer), "AAEC");
});
