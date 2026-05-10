const MAX_DISPLAY_ROWS = 2000;

export default {
	id: "csv-preview",
	onload(host) {
		host.registerFilePreview({
			extensions: ["csv", "tsv"],
			async onOpen(ctx) {
				const abs = ctx.fsRoot
					? `${ctx.fsRoot}/${ctx.filePath}`
					: ctx.filePath;
				const raw = await host.readFile(abs);
				const delimiter = ctx.filePath.endsWith(".tsv") ? "\t" : ",";
				const rows = parseCsv(raw, delimiter);
				const html = buildTableHtml(rows, ctx.filePath);
				host.openPanel({
					id: `csv-${ctx.filePath}`,
					title: ctx.filePath.split("/").pop() || "CSV",
					html,
					onMessage(data) {
						if (data.type === "edit") {
							host.openEditorTab(ctx.filePath, ctx.repoPath, {
								fsRoot: ctx.fsRoot,
							});
						}
					},
				});
			},
		});
	},
	onunload() {},
};

function parseCsv(raw, delimiter) {
	const rows = [];
	let i = 0;
	const len = raw.length;

	while (i < len) {
		const row = [];
		while (i < len) {
			if (raw[i] === '"') {
				i++;
				let field = "";
				while (i < len) {
					if (raw[i] === '"') {
						if (i + 1 < len && raw[i + 1] === '"') {
							field += '"';
							i += 2;
						} else {
							i++;
							break;
						}
					} else {
						field += raw[i];
						i++;
					}
				}
				row.push(field);
				if (i < len && raw[i] === delimiter) i++;
				else if (i < len && (raw[i] === "\n" || raw[i] === "\r")) {
					if (raw[i] === "\r" && i + 1 < len && raw[i + 1] === "\n") i += 2;
					else i++;
					break;
				}
			} else {
				let end = i;
				while (end < len && raw[end] !== delimiter && raw[end] !== "\n" && raw[end] !== "\r") end++;
				row.push(raw.slice(i, end));
				i = end;
				if (i < len && raw[i] === delimiter) i++;
				else if (i < len && (raw[i] === "\n" || raw[i] === "\r")) {
					if (raw[i] === "\r" && i + 1 < len && raw[i + 1] === "\n") i += 2;
					else i++;
					break;
				}
			}
		}
		if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
			rows.push(row);
		}
	}
	return rows;
}

function esc(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const COLUMN_HUES = [210, 160, 30, 340, 120, 270, 50, 190];

function buildTableHtml(rows, fileName) {
	if (rows.length === 0) {
		return `<div class="empty-state">Empty file</div>`;
	}

	const headers = rows[0];
	const dataRows = rows.slice(1);
	const totalRows = dataRows.length;
	const capped = totalRows > MAX_DISPLAY_ROWS;
	const displayRows = capped ? dataRows.slice(0, MAX_DISPLAY_ROWS) : dataRows;
	const colCount = headers.length;

	let colStyles = "";
	for (let c = 0; c < colCount; c++) {
		const hue = COLUMN_HUES[c % COLUMN_HUES.length];
		colStyles += `
			td:nth-child(${c + 1}) { background: hsla(${hue}, 50%, 50%, 0.04); }
			th:nth-child(${c + 1}) { background: hsla(${hue}, 50%, 40%, 0.12); }`;
	}

	let headerHtml = "<tr>";
	for (let c = 0; c < colCount; c++) {
		headerHtml += `<th data-col="${c}" style="cursor:pointer" onclick="sortByCol(${c})">${esc(headers[c])} <span class="sort-arrow" id="arrow-${c}"></span></th>`;
	}
	headerHtml += "</tr>";

	let bodyHtml = "";
	for (const row of displayRows) {
		bodyHtml += "<tr>";
		for (let c = 0; c < colCount; c++) {
			bodyHtml += `<td>${esc(row[c] ?? "")}</td>`;
		}
		bodyHtml += "</tr>";
	}

	const cappedNotice = capped
		? `<div class="hint" style="margin:8px 0">Showing ${MAX_DISPLAY_ROWS.toLocaleString()} of ${totalRows.toLocaleString()} rows</div>`
		: "";

	return `
<style>
	${colStyles}
	thead { position: sticky; top: 0; z-index: 1; }
	th .sort-arrow { font-size: 0.75em; opacity: 0.6; }
	.csv-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 0;
		border-bottom: 1px solid var(--border, #333);
		margin-bottom: 8px;
	}
	.csv-toolbar .info {
		font-size: 0.85em;
		opacity: 0.7;
	}
</style>
<div class="csv-toolbar">
	<span class="info">${esc(fileName.split("/").pop() || "")} — ${totalRows.toLocaleString()} row${totalRows !== 1 ? "s" : ""}, ${colCount} col${colCount !== 1 ? "s" : ""}</span>
	<button class="primary" onclick="postMessage({type:'edit'})">Edit</button>
</div>
${cappedNotice}
<table>
	<thead>${headerHtml}</thead>
	<tbody id="csv-body">${bodyHtml}</tbody>
</table>
<script>
	let sortCol = -1;
	let sortAsc = true;
	const data = ${JSON.stringify(displayRows)};
	const colCount = ${colCount};

	function sortByCol(col) {
		if (sortCol === col) sortAsc = !sortAsc;
		else { sortCol = col; sortAsc = true; }

		for (let i = 0; i < colCount; i++) {
			const el = document.getElementById("arrow-" + i);
			if (el) el.textContent = i === col ? (sortAsc ? "▲" : "▼") : "";
		}

		data.sort((a, b) => {
			const va = (a[col] ?? ""), vb = (b[col] ?? "");
			const na = Number(va), nb = Number(vb);
			if (!isNaN(na) && !isNaN(nb) && va !== "" && vb !== "") {
				return sortAsc ? na - nb : nb - na;
			}
			return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
		});

		const tbody = document.getElementById("csv-body");
		let html = "";
		for (const row of data) {
			html += "<tr>";
			for (let c = 0; c < colCount; c++) {
				const v = row[c] ?? "";
				html += "<td>" + v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</td>";
			}
			html += "</tr>";
		}
		tbody.innerHTML = html;
	}

	function postMessage(msg) {
		window.parent.postMessage(msg, "*");
	}
</script>`;
}
