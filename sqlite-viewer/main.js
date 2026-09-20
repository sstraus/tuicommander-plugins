const PLUGIN_ID = "sqlite-viewer";
export const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

const ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c-3.31 0-6 1.12-6 2.5v9C2 13.88 4.69 15 8 15s6-1.12 6-2.5v-9C14 2.12 11.31 1 8 1Zm0 1.5c2.76 0 4.5.76 4.5 1s-1.74 1-4.5 1-4.5-.76-4.5-1 1.74-1 4.5-1Zm4.5 10c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1v-1.35c1.1.55 2.72.85 4.5.85s3.4-.3 4.5-.85v1.35Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V8.15C4.6 8.7 6.22 9 8 9s3.4-.3 4.5-.85V9.5Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V5.15C4.6 5.7 6.22 6 8 6s3.4-.3 4.5-.85V6.5Z"/></svg>';

export default {
	id: PLUGIN_ID,
	onload(host) {
		host.registerFilePreview({
			extensions: ["db", "sqlite", "sqlite3", "db3", "s3db"],
			onOpen(ctx) {
				void openDatabase(host, ctx);
			},
		});
	},
	onunload() {},
};

export async function openDatabase(host, ctx, assetLoader = loadViewerAssets) {
	const absolute = absolutePath(ctx.fsRoot, ctx.filePath);
	const name = basename(ctx.filePath);
	const assets = assetUrls(import.meta.url);
	const controller = new AbortController();
	const state = {
		closed: false,
		ready: false,
		databaseBuffer: null,
		wasmBuffer: null,
		error: null,
		panel: null,
	};

	const deliver = () => {
		if (state.closed || !state.ready || !state.panel) return;
		if (state.error) {
			state.panel.send({ type: "load-error", message: state.error });
			state.error = null;
			return;
		}
		if (!state.databaseBuffer || !state.wasmBuffer) return;
		const databaseBuffer = state.databaseBuffer;
		const wasmBuffer = state.wasmBuffer;
		state.databaseBuffer = null;
		state.wasmBuffer = null;
		state.panel.send(
			{ type: "load-database", name, path: absolute, databaseBuffer, wasmBuffer },
			[databaseBuffer, wasmBuffer],
		);
	};

	state.panel = host.openPanel({
		id: panelId(absolute),
		title: shortTitle(name),
		html: buildLoadingHtml(name),
		onMessage(message) {
			if (message?.type === "sqlite-viewer-ready") {
				state.ready = true;
				deliver();
				return;
			}
			if (message?.type === "save-database" && message.buffer instanceof ArrayBuffer) {
				void saveDatabase(host, state, absolute, message.buffer, message.requestId);
			}
		},
		onClose() {
			state.closed = true;
			controller.abort();
			state.databaseBuffer = null;
			state.wasmBuffer = null;
			state.panel = null;
		},
	});

	const databaseLoad = host
		.readFileBase64(absolute, { maxBytes: MAX_DATABASE_BYTES })
		.then((encoded) => {
			if (state.closed) return;
			state.databaseBuffer = base64ToArrayBuffer(encoded);
			deliver();
		})
		.catch((error) => {
			if (state.closed) return;
			state.error = describeLoadError(error, MAX_DATABASE_BYTES);
			deliver();
		});

	try {
		const runtime = await assetLoader(assets, controller.signal);
		if (state.closed) return;
		state.wasmBuffer = runtime.wasmBuffer;
		state.panel.update(buildPanelHtml(name, runtime.loaderSource, runtime.panelSource));
	} catch (error) {
		if (state.closed) return;
		state.error = `Could not load the bundled SQLite WebAssembly runtime.\n${errorMessage(error)}`;
		state.panel.update(buildFatalHtml(name, state.error));
	}

	await databaseLoad;
	deliver();
}

async function saveDatabase(host, state, path, buffer, requestId) {
	try {
		const encoded = arrayBufferToBase64(buffer);
		await host.writeFileBase64(path, encoded, { maxBytes: MAX_DATABASE_BYTES });
		if (!state.closed) state.panel?.send({ type: "save-result", requestId, ok: true });
	} catch (error) {
		if (!state.closed) {
			state.panel?.send({ type: "save-result", requestId, ok: false, message: errorMessage(error) });
		}
	}
}

export function assetUrls(moduleUrl) {
	const base = new URL(".", moduleUrl);
	return {
		panel: new URL("panel.bundle.js", base).href,
		wasm: new URL("vendor/sql-wasm.wasm", base).href,
		loader: new URL("vendor/sql-wasm.js", base).href,
	};
}

export async function loadViewerAssets(assets, signal) {
	const [loaderResponse, panelResponse, wasmResponse] = await Promise.all([
		fetch(assets.loader, { signal }),
		fetch(assets.panel, { signal }),
		fetch(assets.wasm, { signal }),
	]);
	for (const response of [loaderResponse, panelResponse, wasmResponse]) {
		if (!response.ok) throw new Error(`Asset request failed with HTTP ${response.status}.`);
	}
	const [loaderSource, panelSource, wasmBuffer] = await Promise.all([
		loaderResponse.text(),
		panelResponse.text(),
		wasmResponse.arrayBuffer(),
	]);
	return { loaderSource, panelSource, wasmBuffer };
}

export function buildPanelHtml(name, loaderSource, panelSource) {
	const inlineLoader = escapeInlineScript(loaderSource);
	const inlinePanel = escapeInlineScript(panelSource);
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>
body { overflow: hidden; }
[hidden] { display: none !important; }
.sqlite-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100vh; }
.sqlite-sidebar { border-right: 1px solid var(--border); overflow: auto; padding: 14px 12px; background: var(--bg-secondary); }
.sqlite-brand { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; }
.sqlite-brand-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto; border: 1px solid var(--border); border-radius: 7px; color: var(--accent); background: var(--bg-tertiary); }
.sqlite-brand-icon svg, .sqlite-title-icon svg { width: 18px; height: 18px; }
.sqlite-brand-title { color: var(--fg-primary); font-weight: 700; }
.sqlite-brand-subtitle { color: var(--fg-muted); font-size: 11px; }
.sqlite-main { min-width: 0; overflow: auto; }
.sqlite-title { display: flex; gap: 10px; align-items: center; min-width: 0; }
.sqlite-title-icon { display: grid; place-items: center; color: var(--accent); }
.sqlite-header-actions { display: flex; gap: 8px; align-items: center; }
.sqlite-object { position: relative; width: 100%; display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; text-align: left; overflow: hidden; }
.sqlite-object-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sqlite-object.active { border-color: var(--accent); color: var(--accent); background: var(--bg-highlight); }
.sqlite-object.active::before { content: ""; position: absolute; inset: 4px auto 4px 3px; width: 2px; border-radius: 2px; background: var(--accent); }
.sqlite-workspace { display: grid; gap: 14px; }
.sqlite-section-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.sqlite-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sqlite-filter-bar { display: grid; grid-template-columns: minmax(120px, 180px) minmax(160px, 1fr) auto; gap: 8px; margin: 10px 0; }
.sqlite-filter-bar select, .sqlite-filter-bar input { min-width: 0; }
.sqlite-filters { display: flex; flex-wrap: wrap; gap: 6px; min-height: 22px; margin-bottom: 10px; }
.sqlite-filter-chip { display: inline-flex; gap: 5px; align-items: center; max-width: 320px; }
.sqlite-filter-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sqlite-indexes { margin: 10px 0; }
.sqlite-index-list { display: grid; gap: 6px; margin-top: 8px; }
.sqlite-index { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 8px; align-items: center; }
.sqlite-index-columns { grid-column: 1 / -1; color: var(--fg-muted); font-size: 11px; }
.sqlite-table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.sqlite-table-wrap table { width: max-content; min-width: 100%; margin: 0; }
.sqlite-table-wrap th { position: sticky; top: 0; z-index: 2; background: var(--bg-secondary); }
.sqlite-table-wrap th:first-child, .sqlite-table-wrap td:first-child { position: sticky; left: 0; z-index: 1; background: var(--bg-secondary); box-shadow: 1px 0 0 var(--border); }
.sqlite-table-wrap th:first-child { z-index: 3; }
.sqlite-cell { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sqlite-cell.null, .sqlite-cell.blob { color: var(--fg-muted); font-style: italic; }
.sqlite-cell.editable { cursor: text; }
.sqlite-cell.editable:hover { outline: 1px solid var(--accent); outline-offset: -1px; background: var(--bg-highlight); }
.sqlite-cell-editor { width: min(280px, 50vw); }
.sqlite-query { min-height: 100px; width: 100%; font-family: var(--font-mono, monospace); line-height: 1.5; }
.sqlite-status { min-height: 20px; color: var(--fg-secondary); }
.sqlite-error { color: var(--error); white-space: pre-wrap; }
.sqlite-plan { display: grid; gap: 6px; margin-top: 10px; }
.sqlite-plan-step { position: relative; margin-left: calc(var(--depth, 0) * 18px); padding: 8px 10px; border-left: 2px solid var(--accent); }
.sqlite-plan-step::before { content: ""; position: absolute; left: -2px; top: 50%; width: 8px; border-top: 2px solid var(--accent); }
.sqlite-plan-meta { color: var(--fg-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
@media (max-width: 760px) { .sqlite-shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .sqlite-sidebar { max-height: 200px; border-right: 0; border-bottom: 1px solid var(--border); } .sqlite-filter-bar { grid-template-columns: 1fr; } }
</style>
</head><body>
<div class="sqlite-shell">
  <aside class="sqlite-sidebar">
    <div class="sqlite-brand"><div class="sqlite-brand-icon"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c-3.31 0-6 1.12-6 2.5v9C2 13.88 4.69 15 8 15s6-1.12 6-2.5v-9C14 2.12 11.31 1 8 1Zm0 1.5c2.76 0 4.5.76 4.5 1s-1.74 1-4.5 1-4.5-.76-4.5-1 1.74-1 4.5-1Zm4.5 10c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1v-1.35c1.1.55 2.72.85 4.5.85s3.4-.3 4.5-.85v1.35Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V8.15C4.6 8.7 6.22 9 8 9s3.4-.3 4.5-.85V9.5Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V5.15C4.6 5.7 6.22 6 8 6s3.4-.3 4.5-.85V6.5Z"/></svg></div><div><div class="sqlite-brand-title">SQLite Explorer</div><div class="sqlite-brand-subtitle" id="object-summary">Loading objects…</div></div></div>
    <h2 class="dash-section-title">Tables &amp; views</h2>
    <div id="objects"><div class="hint">Loading SQLite…</div></div>
  </aside>
  <main class="sqlite-main dashboard">
    <div class="dash-header"><div class="sqlite-title"><div class="sqlite-title-icon"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c-3.31 0-6 1.12-6 2.5v9C2 13.88 4.69 15 8 15s6-1.12 6-2.5v-9C14 2.12 11.31 1 8 1Zm0 1.5c2.76 0 4.5.76 4.5 1s-1.74 1-4.5 1-4.5-.76-4.5-1 1.74-1 4.5-1Zm4.5 10c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1v-1.35c1.1.55 2.72.85 4.5.85s3.4-.3 4.5-.85v1.35Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V8.15C4.6 8.7 6.22 9 8 9s3.4-.3 4.5-.85V9.5Zm0-3c0 .24-1.74 1-4.5 1s-4.5-.76-4.5-1V5.15C4.6 5.7 6.22 6 8 6s3.4-.3 4.5-.85V6.5Z"/></svg></div><div><h1 class="dash-title">${escapeHtml(name)}</h1><div class="dash-subtitle" id="database-meta">Local WebAssembly database</div></div></div><div class="sqlite-header-actions"><span id="dirty-state" class="badge badge-warning" hidden>UNSAVED</span><button id="edit-mode">Enable editing</button><button id="save-changes" class="primary" disabled>Save changes</button></div></div>
    <div id="fatal" class="empty-state" hidden></div>
    <div id="workspace" class="sqlite-workspace" hidden>
      <div class="dash-stat-grid"><div class="dash-stat"><div class="dash-stat-label">Objects</div><div class="dash-stat-value" id="object-count">—</div><div class="dash-stat-sub">tables and views</div></div><div class="dash-stat"><div class="dash-stat-label">Rows</div><div class="dash-stat-value" id="row-count">—</div><div class="dash-stat-sub">after filters</div></div><div class="dash-stat"><div class="dash-stat-label">Columns</div><div class="dash-stat-value" id="column-count">—</div><div class="dash-stat-sub">horizontal scroll enabled</div></div></div>
      <section class="card"><div class="sqlite-section-header"><div><h2 class="dash-section-title" id="object-title">Choose a table or view</h2><div id="schema" class="hint"></div></div><div class="sqlite-toolbar"><label for="page-size">Rows</label><select id="page-size"><option>50</option><option selected>100</option><option>250</option></select><button id="prev-page">Previous</button><span id="page-label" class="hint"></span><button id="next-page">Next</button></div></div><details class="sqlite-indexes"><summary>Indexes <span id="index-count" class="badge badge-muted">0</span></summary><div id="indexes" class="sqlite-index-list"></div></details><div class="sqlite-filter-bar"><select id="filter-column" aria-label="Column to filter"></select><input id="filter-value" type="search" placeholder="Contains…" aria-label="Filter value"><button id="add-filter">Add filter</button></div><div id="filters" class="sqlite-filters"><span class="hint">No column filters</span></div><div id="rows" class="sqlite-table-wrap"></div></section>
      <section class="card"><div class="sqlite-section-header"><div><h2 class="dash-section-title">Query console</h2><div class="hint">One statement · up to 500 rows · runs against the current snapshot</div></div><span class="badge badge-success">QUERY ONLY</span></div><textarea id="query" class="sqlite-query" spellcheck="false">SELECT name, type FROM sqlite_schema ORDER BY type, name LIMIT 100;</textarea><div class="sqlite-toolbar"><button id="run-query" class="primary">Run query</button><button id="explain-query">Explain plan</button><button id="copy-results" disabled>Copy CSV</button><span class="hint">Cmd/Ctrl + Enter</span></div><div id="query-status" class="sqlite-status"></div><div id="query-plan" class="sqlite-plan"></div><div id="query-results" class="sqlite-table-wrap"></div></section>
    </div>
  </main>
</div>
<script>${inlineLoader}</script>
<script>${inlinePanel}</script>
</body></html>`;
}

export function buildLoadingHtml(name) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body><main class="dashboard"><div class="empty-state">Loading SQLite WebAssembly…</div></main></body></html>`;
}

export function buildFatalHtml(name, message) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body><main class="dashboard"><div class="empty-state"><div class="sqlite-error">${escapeHtml(message)}</div></div></main></body></html>`;
}

export function base64ToArrayBuffer(encoded) {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

export function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

export function absolutePath(root, filePath) {
	if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\")) return filePath;
	if (!root) return filePath;
	const separator = root.includes("\\") ? "\\" : "/";
	return root.replace(/[\\/]+$/, "") + separator + filePath.replace(/^[\\/]+/, "");
}

export function basename(path) {
	const normalized = String(path).replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function panelId(path) {
	let hash = 2166136261;
	for (const char of String(path)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return `sqlite-${(hash >>> 0).toString(16)}`;
}

function shortTitle(name) {
	return name.length <= 48 ? name : `${name.slice(0, 45)}…`;
}

function describeLoadError(error, maxBytes) {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("File exceeds maximum size")) {
		return `${message}\nSQLite Viewer loads databases into WebAssembly memory and supports files up to ${formatBytes(maxBytes)}.`;
	}
	return `Could not open this SQLite database.\n${message}`;
}

function formatBytes(bytes) {
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function escapeInlineScript(source) {
	return String(source).replaceAll("</script", "<\\/script");
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export { ICON };
