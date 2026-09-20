import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_CELL_CHARS,
	MAX_QUERY_CHARS,
	boundedPage,
	columnFilterWhere,
	coerceEditedValue,
	formatCell,
	formatCsv,
	hasSQLiteHeader,
	quoteIdentifier,
	singleStatement,
	validateQuery,
} from "./model.js";

test("quotes arbitrary SQLite identifiers", () => {
	assert.equal(quoteIdentifier('odd"table'), '"odd""table"');
});

test("recognizes the standard SQLite header", () => {
	assert.equal(hasSQLiteHeader(new TextEncoder().encode("SQLite format 3\0more")), true);
	assert.equal(hasSQLiteHeader(new TextEncoder().encode("encrypted bytes")), false);
});

test("formats nulls, blobs, and bounded text", () => {
	assert.deepEqual(formatCell(null), { text: "NULL", kind: "null" });
	assert.deepEqual(formatCell(new Uint8Array([1, 2, 3])), { text: "<BLOB 3 bytes>", kind: "blob" });
	const formatted = formatCell("x".repeat(MAX_CELL_CHARS + 1));
	assert.equal(formatted.text.length, MAX_CELL_CHARS + 1);
	assert.equal(formatted.truncated, true);
});

test("formats query results as RFC-style CSV", () => {
	assert.equal(formatCsv(["name", "note"], [["Ada", 'a,"b"'], [null, new Uint8Array([1, 2])]]), 'name,note\nAda,"a,""b"""\n,<BLOB 2 bytes>');
});

test("clamps pagination to the available rows", () => {
	assert.equal(boundedPage(-1, 250), 0);
	assert.equal(boundedPage(99, 250), 2);
	assert.equal(boundedPage(99, 250, 50), 4);
	assert.equal(boundedPage(Number.NaN, 0), 0);
});

test("builds parameterized column filters and escapes LIKE wildcards", () => {
	assert.deepEqual(
		columnFilterWhere([
			{ column: 'odd"name', value: "50%" },
			{ column: "path", value: "a_b\\c" },
		]),
		{
			clause: ' WHERE CAST("odd""name" AS TEXT) LIKE ? ESCAPE \'\\\' AND CAST("path" AS TEXT) LIKE ? ESCAPE \'\\\'',
			params: ["%50\\%%", "%a\\_b\\\\c%"],
		},
	);
	assert.deepEqual(columnFilterWhere([]), { clause: "", params: [] });
});

test("coerces inline edits according to SQLite type affinity", () => {
	assert.equal(coerceEditedValue("42", "INTEGER", 1), 42);
	assert.equal(coerceEditedValue("4.25", "DOUBLE PRECISION", 1), 4.25);
	assert.equal(coerceEditedValue("", "TEXT", null), null);
	assert.equal(coerceEditedValue("0042", "TEXT", "old"), "0042");
	assert.throws(() => coerceEditedValue("4.2", "INTEGER", 1), /safe integer/);
	assert.throws(() => coerceEditedValue("NaN", "REAL", 1), /finite numeric/);
});

test("requires bounded non-empty query text", () => {
	assert.throws(() => validateQuery("  "), /Enter a SQL query/);
	assert.throws(() => validateQuery("x".repeat(MAX_QUERY_CHARS + 1)), /exceeds/);
	assert.equal(validateQuery(" SELECT 1; "), "SELECT 1;");
});

test("rejects a second SQL statement and frees the prepared statement", () => {
	let firstFreed = false;
	let secondFreed = false;
	let call = 0;
	const db = {
		iterateStatements() {
			call += 1;
			if (call === 1) {
				const iterator = [{ free: () => (firstFreed = true) }][Symbol.iterator]();
				iterator.getRemainingSQL = () => " DELETE FROM users";
				return iterator;
			}
			return [{ free: () => (secondFreed = true) }][Symbol.iterator]();
		},
	};
	assert.throws(() => singleStatement(db, "SELECT 1; DELETE FROM users"), /one SQL statement/);
	assert.equal(firstFreed, true);
	assert.equal(secondFreed, true);
});
