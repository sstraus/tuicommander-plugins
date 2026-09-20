# SQLite Viewer

SQLite database inspection and focused data editing inside TUICommander. Open a `.db`, `.sqlite`, `.sqlite3`, `.db3`, or `.s3db` file from the File Browser to browse tables, views, columns, indexes, filtered and paginated rows, query plans, and one SQL statement at a time.

The plugin is self-contained: `sql.js` 1.14.1 and its WebAssembly binary ship in `vendor/`. It makes no network request and requires no system SQLite installation. The loader and generated panel bundle are embedded into the panel document; the WASM and database buffers transfer into that iframe. Closing the tab aborts pending asset loads and destroys the realm that owns the live engine and database.

Editing is explicit: enable edit mode for a table with a primary key, double-click a non-key scalar cell, then save the exported database through the host's bounded atomic binary-write API. Custom SQL remains read-only.

## Features and limits

- Native SQL `COUNT`, filters, ordering, `LIMIT`, and `OFFSET`; only the current 50, 100, or 250-row page is rendered.
- Per-column contains filters, sortable headers, CSV copy, index inspection, and visual `EXPLAIN QUERY PLAN` output.
- Inline editing for non-key scalar cells in tables with a primary key; explicit atomic save replaces the source database.
- Custom queries run with `PRAGMA query_only=ON`, one statement at a time, and return at most 500 rows.
- Maximum database size: 256 MiB.
- 200 displayed columns and 500 displayed characters per cell.
- A database being concurrently modified may be stale because WAL/journal sidecars are not replayed.
- Standard SQLite databases only. SQLCipher/encrypted files are detected and reported, but cannot be decrypted by the bundled stock sql.js engine.
- Unsaved in-memory edits are discarded when the viewer tab closes.

## Capabilities

- `ui:file-preview`
- `ui:panel`
- `fs:read`
- `fs:write`

## Third-party software

The bundled `sql.js` artifacts are licensed under MIT. See `vendor/LICENSE.sql.js`.

## Development

`panel.bundle.js` is generated from `panel.js` and `model.js` so the sandboxed `srcdoc` panel does not depend on external module loading:

```bash
pnpm exec esbuild plugins/sqlite-viewer/panel.js --bundle --format=iife --target=es2022 --outfile=plugins/sqlite-viewer/panel.bundle.js
```
