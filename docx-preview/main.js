import "./vendor/mammoth.browser.min.js";

const PLUGIN_ID = "docx-preview";
const MAX_PANEL_TITLE = 48;

const mammothApi = globalThis.mammoth;

export default {
	id: PLUGIN_ID,
	onload(host) {
		host.registerFilePreview({
			extensions: ["docx", "dotx"],
			async onOpen(ctx) {
				try {
					if (!mammothApi?.convertToHtml || !mammothApi?.extractRawText) {
						throw new Error("Mammoth.js did not initialize");
					}

					const abs = absolutePath(ctx.fsRoot, ctx.filePath);
					const base64 = await host.readFileBase64(abs);
					const arrayBuffer = base64ToArrayBuffer(base64);
					const fileName = basename(ctx.filePath);

					const [htmlResult, textResult] = await Promise.all([
						mammothApi.convertToHtml(
							{ arrayBuffer },
							{
								convertImage: mammothApi.images.imgElement((image) =>
									image.readAsBase64String().then((imageBuffer) => ({
										src: `data:${image.contentType};base64,${imageBuffer}`,
									})),
								),
								ignoreEmptyParagraphs: false,
								includeDefaultStyleMap: true,
							},
						),
						mammothApi.extractRawText({ arrayBuffer: arrayBuffer.slice(0) }),
					]);

					host.openPanel({
						id: panelId(ctx.filePath),
						title: shortTitle(fileName),
						html: buildPanelHtml({
							fileName,
							html: htmlResult.value,
							rawText: textResult.value,
							messages: [...(htmlResult.messages ?? []), ...(textResult.messages ?? [])],
						}),
						onMessage(data) {
							if (data && typeof data === "object" && data.type === "edit") {
								host.openEditorTab(ctx.filePath, ctx.repoPath, { fsRoot: ctx.fsRoot });
							}
						},
					});
				} catch (error) {
					host.openPanel({
						id: panelId(ctx.filePath),
						title: shortTitle(basename(ctx.filePath)),
						html: buildErrorHtml(ctx.filePath, error),
					});
				}
			},
		});
	},
	onunload() {},
};

function absolutePath(root, filePath) {
	if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\")) return filePath;
	if (!root) return filePath;
	const sep = root.includes("\\") ? "\\" : "/";
	return root.replace(/[\\/]+$/, "") + sep + filePath.replace(/^[\\/]+/, "");
}

function basename(path) {
	const normalized = String(path).replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function shortTitle(name) {
	if (name.length <= MAX_PANEL_TITLE) return name;
	const extAt = name.lastIndexOf(".");
	const ext = extAt > 0 ? name.slice(extAt) : "";
	return `${name.slice(0, MAX_PANEL_TITLE - ext.length - 3)}...${ext}`;
}

function panelId(filePath) {
	let hash = 2166136261;
	for (let i = 0; i < filePath.length; i++) {
		hash ^= filePath.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `docx-${(hash >>> 0).toString(16)}`;
}

function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function esc(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escScript(value) {
	return JSON.stringify(String(value)).replace(/</g, "\\u003c");
}

function messageText(message) {
	if (typeof message === "string") return message;
	if (!message || typeof message !== "object") return String(message);
	const type = message.type ? `${message.type}: ` : "";
	return `${type}${message.message ?? JSON.stringify(message)}`;
}

function buildPanelHtml({ fileName, html, rawText, messages }) {
	const warnings = messages.length
		? `<details class="messages"><summary>${messages.length} conversion note${messages.length === 1 ? "" : "s"}</summary><ul>${messages
				.map((message) => `<li>${esc(messageText(message))}</li>`)
				.join("")}</ul></details>`
		: "";

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<style>
		:root { color-scheme: light dark; }
		body {
			margin: 0;
			background: var(--bg-primary, #111);
			color: var(--fg-primary, #eee);
			font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		.toolbar {
			position: sticky;
			top: 0;
			z-index: 3;
			display: flex;
			align-items: center;
			gap: 8px;
			min-height: 42px;
			padding: 6px 12px;
			border-bottom: 1px solid var(--border, #333);
			background: var(--bg-primary, #111);
		}
		.title {
			min-width: 0;
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 600;
		}
		.actions {
			display: flex;
			gap: 6px;
		}
		button {
			border: 1px solid var(--border, #444);
			border-radius: 6px;
			background: var(--bg-secondary, #1c1c1c);
			color: var(--fg-primary, #eee);
			padding: 4px 9px;
			font: inherit;
			cursor: pointer;
		}
		button[aria-pressed="true"] {
			border-color: var(--accent, #6aa7ff);
			background: color-mix(in srgb, var(--accent, #6aa7ff) 18%, transparent);
		}
		.messages {
			margin: 12px auto 0;
			max-width: 860px;
			padding: 8px 12px;
			border: 1px solid var(--warning, #a87900);
			border-radius: 6px;
			background: color-mix(in srgb, var(--warning, #a87900) 12%, transparent);
			color: var(--fg-primary, #eee);
		}
		.document {
			box-sizing: border-box;
			max-width: 860px;
			margin: 0 auto;
			padding: 24px 28px 48px;
		}
		.document h1, .document h2, .document h3 { line-height: 1.25; }
		.document table {
			border-collapse: collapse;
			width: 100%;
			margin: 12px 0;
		}
		.document th, .document td {
			border: 1px solid var(--border, #444);
			padding: 6px 8px;
			vertical-align: top;
		}
		.document img {
			max-width: 100%;
			height: auto;
		}
		.raw {
			display: none;
			box-sizing: border-box;
			width: 100%;
			max-width: 860px;
			margin: 0 auto;
			padding: 24px 28px 48px;
			white-space: pre-wrap;
			font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}
		body[data-mode="raw"] .document { display: none; }
		body[data-mode="raw"] .raw { display: block; }
		@media (max-width: 700px) {
			.document, .raw { padding: 18px 16px 36px; }
			.toolbar { padding-inline: 8px; }
		}
	</style>
</head>
<body data-mode="html">
	<div class="toolbar">
		<div class="title" title="${esc(fileName)}">${esc(fileName)}</div>
		<div class="actions">
			<button type="button" id="htmlBtn" aria-pressed="true">HTML</button>
			<button type="button" id="rawBtn" aria-pressed="false">Raw text</button>
			<button type="button" id="editBtn">Edit</button>
		</div>
	</div>
	${warnings}
	<main class="document">${html || '<p class="empty-state">No previewable content.</p>'}</main>
	<pre class="raw">${esc(rawText)}</pre>
	<script>
		const htmlBtn = document.getElementById("htmlBtn");
		const rawBtn = document.getElementById("rawBtn");
		document.getElementById("editBtn").addEventListener("click", () => {
			window.parent.postMessage({ type: "edit" }, "*");
		});
		htmlBtn.addEventListener("click", () => setMode("html"));
		rawBtn.addEventListener("click", () => setMode("raw"));
		function setMode(mode) {
			document.body.dataset.mode = mode;
			htmlBtn.setAttribute("aria-pressed", String(mode === "html"));
			rawBtn.setAttribute("aria-pressed", String(mode === "raw"));
		}
	</script>
</body>
</html>`;
}

function buildErrorHtml(filePath, error) {
	const message = error instanceof Error ? error.message : String(error);
	return `<!doctype html>
<html>
<body style="margin:0;padding:24px;font:13px/1.5 system-ui;color:var(--fg-primary);background:var(--bg-primary)">
	<h2 style="margin-top:0">DOCX preview failed</h2>
	<p><strong>${esc(basename(filePath))}</strong></p>
	<pre style="white-space:pre-wrap;color:var(--error,#e55)">${esc(message)}</pre>
</body>
</html>`;
}
