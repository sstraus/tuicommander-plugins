/**
 * Tests for the XLSX Preview plugin.
 *
 * Run: node --test xlsx-preview/
 *
 * The plugin is driven through the surface the app gives it — a PluginHost double
 * whose `readFileBase64` returns a workbook SheetJS just wrote — because the thing
 * under test is the whole path from bytes to panel HTML. Asserting on an
 * intermediate cell object would pass while the panel renders nothing.
 *
 * The vendored SheetJS bundle is UMD and publishes itself on `window`, which the
 * WebView has and node does not: stub it before importing the plugin, or the
 * plugin binds `xlsxApi` to undefined.
 */

import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
const { default: plugin } = await import("./main.js");
const XLSX = globalThis.XLSX;

const HEADER_ROW = ["Name", "Qty", "Due"];
const HOSTILE_CELL = "Nut & <script>x</script>";

/** A two-sheet workbook: one with data of every display type, one empty. */
function sampleWorkbook() {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		wb,
		XLSX.utils.aoa_to_sheet([
			HEADER_ROW,
			// Local-time constructor, not `Date.UTC(...)`: SheetJS reads a Date's
			// display components (year/month/day) via local-time getters, not UTC, so a
			// UTC-midnight timestamp reads back as the day before in any negative-UTC-
			// offset timezone — this made the assertion below flake between "1/15/26"
			// and "1/14/26" depending on the machine running it.
			["Bolt", 3, new Date(2026, 0, 15)],
			[HOSTILE_CELL, 12, ""],
		]),
		"Parts",
	);
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
	return wb;
}

/** Run the registered preview handler over `base64` and return the opened panel. */
async function preview(base64, fileName) {
	let registered = null;
	let panel = null;
	plugin.onload({
		registerFilePreview: (options) => {
			registered = options;
		},
		readFileBase64: async () => base64,
		openPanel: (options) => {
			panel = options;
		},
		openEditorTab: () => {},
	});
	await registered.onOpen({ filePath: `/x/${fileName}`, repoPath: "/x", fsRoot: "/x" });
	return { registered, panel };
}

/** The sheet payload the panel script renders from. */
function sheetsOf(panel) {
	return JSON.parse(panel.html.match(/const SHEETS = (.*);/)[1]);
}

function encode(workbook, bookType) {
	return XLSX.write(workbook, { type: "base64", bookType, cellDates: true });
}

test("previews every sheet of a workbook", async () => {
	const { registered, panel } = await preview(encode(sampleWorkbook(), "xlsx"), "book.xlsx");

	assert.ok(registered.extensions.includes("xlsx"));
	assert.equal(panel.title, "book.xlsx");
	assert.match(panel.html, />Parts</);
	assert.match(panel.html, />Empty</);

	const [parts, empty] = sheetsOf(panel);
	assert.deepEqual(parts.rows[0], HEADER_ROW);
	assert.equal(parts.totalRows, 3);
	assert.deepEqual(empty.rows, []);
});

test("cells arrive as the strings the spreadsheet displays", async () => {
	const { panel } = await preview(encode(sampleWorkbook(), "xlsx"), "book.xlsx");
	const [parts] = sheetsOf(panel);

	// A number the sorter can still compare numerically, and a date in the
	// workbook's own format rather than a serial number or an ISO timestamp.
	assert.deepEqual(parts.rows[1], ["Bolt", "3", "1/15/26"]);
	// A blank cell is a blank string, so every row is the same width.
	assert.equal(parts.rows[2].length, HEADER_ROW.length);
	assert.equal(parts.rows[2][2], "");
});

test("a cell cannot close the script tag it is embedded in", async () => {
	const { panel } = await preview(encode(sampleWorkbook(), "xlsx"), "book.xlsx");

	assert.doesNotMatch(panel.html, /<script>x<\/script>/);
	assert.match(panel.html, /\\u003cscript/);
	// The value itself survives — it is escaped, not dropped.
	assert.equal(sheetsOf(panel)[0].rows[2][0], HOSTILE_CELL);
});

test("reads the legacy and OpenDocument formats it claims", async () => {
	for (const [bookType, fileName] of [
		["biff8", "legacy.xls"],
		["ods", "open.ods"],
	]) {
		const { registered, panel } = await preview(encode(sampleWorkbook(), bookType), fileName);
		assert.ok(registered.extensions.includes(fileName.split(".").pop()), `${fileName} extension registered`);
		assert.equal(sheetsOf(panel)[0].rows[1][0], "Bolt", `${fileName} rows parsed`);
	}
});

test("caps the rows embedded in the panel and says so", async () => {
	const wb = XLSX.utils.book_new();
	const rows = Array.from({ length: 2500 }, (_, i) => [i]);
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["n"], ...rows]), "Big");

	const { panel } = await preview(encode(wb, "xlsx"), "big.xlsx");
	const [big] = sheetsOf(panel);

	assert.equal(big.rows.length, 2000);
	// The untruncated count is kept so the panel can report what it is hiding.
	assert.equal(big.totalRows, 2501);
});

test("caps the columns embedded in the panel", async () => {
	const wb = XLSX.utils.book_new();
	const wide = Array.from({ length: 260 }, (_, i) => `c${i}`);
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([wide, wide]), "Wide");

	const [sheet] = sheetsOf((await preview(encode(wb, "xlsx"), "wide.xlsx")).panel);

	assert.equal(sheet.rows[0].length, 200);
	assert.equal(sheet.totalCols, 260);
});

test("an unreadable workbook opens an error panel, not a broken table", async () => {
	// A ZIP magic number followed by junk: enough for SheetJS to commit to the
	// xlsx path and then fail inside it.
	const corrupt = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");

	const { panel } = await preview(corrupt, "corrupt.xlsx");

	assert.match(panel.html, /Spreadsheet preview failed/);
	assert.match(panel.html, /corrupt\.xlsx/);
});
