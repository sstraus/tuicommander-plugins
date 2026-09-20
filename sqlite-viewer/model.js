export const MAX_OBJECTS = 1000;
export const PAGE_SIZE = 100;
export const MAX_QUERY_ROWS = 500;
export const MAX_COLUMNS = 200;
export const MAX_CELL_CHARS = 500;
export const MAX_QUERY_CHARS = 100_000;
const SQLITE_HEADER = "SQLite format 3\0";

export function hasSQLiteHeader(buffer) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.byteLength < SQLITE_HEADER.length) return false;
	return [...SQLITE_HEADER].every((character, index) => bytes[index] === character.charCodeAt(0));
}

export function quoteIdentifier(identifier) {
	return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function formatCell(value) {
	if (value == null) return { text: "NULL", kind: "null" };
	if (value instanceof Uint8Array) return { text: `<BLOB ${value.byteLength} bytes>`, kind: "blob" };
	const text = String(value);
	if (text.length <= MAX_CELL_CHARS) return { text, kind: typeof value };
	return { text: `${text.slice(0, MAX_CELL_CHARS)}…`, kind: typeof value, truncated: true };
}

export function formatCsv(columns, rows) {
	const quote = (value) => {
		if (value == null) return "";
		const text = value instanceof Uint8Array ? `<BLOB ${value.byteLength} bytes>` : String(value);
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	return [columns, ...rows].map((row) => row.map(quote).join(",")).join("\n");
}

export function boundedPage(page, totalRows, rowsPerPage = PAGE_SIZE) {
	const pages = Math.max(1, Math.ceil(Math.max(0, totalRows) / rowsPerPage));
	return Math.min(Math.max(0, Number.isFinite(page) ? Math.trunc(page) : 0), pages - 1);
}

export function columnFilterWhere(filters) {
	if (!filters.length) return { clause: "", params: [] };
	const conditions = [];
	const params = [];
	for (const filter of filters) {
		conditions.push(`CAST(${quoteIdentifier(filter.column)} AS TEXT) LIKE ? ESCAPE '\\'`);
		params.push(`%${escapeLikePattern(filter.value)}%`);
	}
	return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
}

export function coerceEditedValue(value, declaredType, originalValue) {
	if (originalValue == null && value === "") return null;
	const type = String(declaredType || "").toUpperCase();
	if (type.includes("INT")) {
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed)) throw new Error("Enter a safe integer value.");
		return parsed;
	}
	if (["REAL", "FLOA", "DOUB", "NUM", "DEC"].some((affinity) => type.includes(affinity))) {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) throw new Error("Enter a finite numeric value.");
		return parsed;
	}
	return value;
}

function escapeLikePattern(value) {
	return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function validateQuery(query) {
	const normalized = String(query).trim();
	if (!normalized) throw new Error("Enter a SQL query first.");
	if (normalized.length > MAX_QUERY_CHARS) {
		throw new Error(`Query exceeds the ${MAX_QUERY_CHARS.toLocaleString()} character limit.`);
	}
	return normalized;
}

export function singleStatement(db, sql) {
	const statements = db.iterateStatements(sql);
	const first = statements.next();
	if (first.done) throw new Error("Query does not contain an executable SQL statement.");
	const remaining = statements.getRemainingSQL();
	let second;
	try {
		second = db.iterateStatements(remaining).next();
	} catch (error) {
		first.value.free();
		throw error;
	}
	if (!second.done) {
		second.value.free();
		first.value.free();
		throw new Error("Run one SQL statement at a time.");
	}
	return first.value;
}
