import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { columnFilterWhere, singleStatement } from "./model.js";

async function loadSqlJs() {
	const loaderPath = path.resolve(import.meta.dirname, "vendor/sql-wasm.js");
	const source = fs.readFileSync(loaderPath, "utf8");
	const commonJsModule = { exports: {} };
	const context = {
		module: commonJsModule,
		exports: commonJsModule.exports,
		require: createRequire(import.meta.url),
		__dirname: path.dirname(loaderPath),
		process,
		console,
		Buffer,
		setTimeout,
		clearTimeout,
		TextDecoder,
		TextEncoder,
		WebAssembly,
	};
	vm.runInNewContext(source, context, { filename: loaderPath });
	const wasmBinary = fs.readFileSync(path.resolve(import.meta.dirname, "vendor/sql-wasm.wasm"));
	return commonJsModule.exports({ wasmBinary });
}

test("the bundled WebAssembly engine filters, explains, edits, exports, and enforces query_only", async () => {
	const SQL = await loadSqlJs();
	const database = new SQL.Database();
	try {
		database.run('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX idx_items_name ON items(name);');
		database.run("INSERT INTO items(name) VALUES (?), (?)", ["alpha", "beta"]);
		database.run("PRAGMA query_only=ON");

		const names = database.exec("SELECT name FROM items ORDER BY id")[0].values.flat();
		const statement = singleStatement(database, "SELECT name FROM items ORDER BY id; -- trailing comment");
		const statementNames = [];
		try {
			while (statement.step()) statementNames.push(statement.get()[0]);
		} finally {
			statement.free();
		}

		assert.deepEqual(Array.from(names), ["alpha", "beta"]);
		assert.deepEqual(statementNames, ["alpha", "beta"]);
		const filter = columnFilterWhere([{ column: "name", value: "ph" }]);
		const filtered = database.exec(`SELECT name FROM items${filter.clause}`, filter.params)[0].values.flat();
		assert.deepEqual(Array.from(filtered), ["alpha"]);
		const plan = database.exec("EXPLAIN QUERY PLAN SELECT * FROM items WHERE name = 'alpha'")[0].values;
		assert.match(String(plan[0][3]), /idx_items_name/);
		assert.throws(() => singleStatement(database, "SELECT 1; SELECT 2"), /one SQL statement/);
		assert.throws(() => database.run("DELETE FROM items"), /readonly/);

		database.run("PRAGMA query_only=OFF");
		database.run("UPDATE items SET name = ? WHERE id = ?", ["updated", 1]);
		const exported = database.export();
		const reopened = new SQL.Database(exported);
		try {
			assert.equal(reopened.exec("SELECT name FROM items WHERE id = 1")[0].values[0][0], "updated");
		} finally {
			reopened.close();
		}
	} finally {
		database.close();
	}
});
