"use strict";
(() => {
  // plugins/sqlite-viewer/model.js
  var MAX_OBJECTS = 1e3;
  var PAGE_SIZE = 100;
  var MAX_QUERY_ROWS = 500;
  var MAX_COLUMNS = 200;
  var MAX_CELL_CHARS = 500;
  var MAX_QUERY_CHARS = 1e5;
  var SQLITE_HEADER = "SQLite format 3\0";
  function hasSQLiteHeader(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < SQLITE_HEADER.length) return false;
    return [...SQLITE_HEADER].every((character, index) => bytes[index] === character.charCodeAt(0));
  }
  function quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
  }
  function formatCell(value) {
    if (value == null) return { text: "NULL", kind: "null" };
    if (value instanceof Uint8Array) return { text: `<BLOB ${value.byteLength} bytes>`, kind: "blob" };
    const text = String(value);
    if (text.length <= MAX_CELL_CHARS) return { text, kind: typeof value };
    return { text: `${text.slice(0, MAX_CELL_CHARS)}\u2026`, kind: typeof value, truncated: true };
  }
  function formatCsv(columns, rows) {
    const quote = (value) => {
      if (value == null) return "";
      const text = value instanceof Uint8Array ? `<BLOB ${value.byteLength} bytes>` : String(value);
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [columns, ...rows].map((row) => row.map(quote).join(",")).join("\n");
  }
  function boundedPage(page, totalRows, rowsPerPage = PAGE_SIZE) {
    const pages = Math.max(1, Math.ceil(Math.max(0, totalRows) / rowsPerPage));
    return Math.min(Math.max(0, Number.isFinite(page) ? Math.trunc(page) : 0), pages - 1);
  }
  function columnFilterWhere(filters) {
    if (!filters.length) return { clause: "", params: [] };
    const conditions = [];
    const params = [];
    for (const filter of filters) {
      conditions.push(`CAST(${quoteIdentifier(filter.column)} AS TEXT) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikePattern(filter.value)}%`);
    }
    return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
  }
  function coerceEditedValue(value, declaredType, originalValue) {
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
  function validateQuery(query) {
    const normalized = String(query).trim();
    if (!normalized) throw new Error("Enter a SQL query first.");
    if (normalized.length > MAX_QUERY_CHARS) {
      throw new Error(`Query exceeds the ${MAX_QUERY_CHARS.toLocaleString()} character limit.`);
    }
    return normalized;
  }
  function singleStatement(db, sql) {
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

  // plugins/sqlite-viewer/panel.js
  var database = null;
  var objects = [];
  var activeObject = null;
  var activePage = 0;
  var activeColumns = [];
  var activeFilters = [];
  var activeSort = null;
  var pageSize = PAGE_SIZE;
  var databasePath = "";
  var editMode = false;
  var dirty = false;
  var saving = false;
  var saveRequestId = 0;
  var editRevision = 0;
  var savingRevision = 0;
  var lastQueryResult = null;
  var initializing = false;
  var elements = {
    objects: document.querySelector("#objects"),
    objectSummary: document.querySelector("#object-summary"),
    fatal: document.querySelector("#fatal"),
    workspace: document.querySelector("#workspace"),
    databaseMeta: document.querySelector("#database-meta"),
    dirtyState: document.querySelector("#dirty-state"),
    editMode: document.querySelector("#edit-mode"),
    saveChanges: document.querySelector("#save-changes"),
    objectCount: document.querySelector("#object-count"),
    rowCount: document.querySelector("#row-count"),
    columnCount: document.querySelector("#column-count"),
    objectTitle: document.querySelector("#object-title"),
    schema: document.querySelector("#schema"),
    indexes: document.querySelector("#indexes"),
    indexCount: document.querySelector("#index-count"),
    rows: document.querySelector("#rows"),
    previous: document.querySelector("#prev-page"),
    next: document.querySelector("#next-page"),
    pageLabel: document.querySelector("#page-label"),
    pageSize: document.querySelector("#page-size"),
    filterColumn: document.querySelector("#filter-column"),
    filterValue: document.querySelector("#filter-value"),
    addFilter: document.querySelector("#add-filter"),
    filters: document.querySelector("#filters"),
    query: document.querySelector("#query"),
    runQuery: document.querySelector("#run-query"),
    explainQuery: document.querySelector("#explain-query"),
    copyResults: document.querySelector("#copy-results"),
    queryStatus: document.querySelector("#query-status"),
    queryPlan: document.querySelector("#query-plan"),
    queryResults: document.querySelector("#query-results")
  };
  elements.previous.addEventListener("click", () => {
    if (!activeObject) return;
    activePage -= 1;
    renderObject();
  });
  elements.next.addEventListener("click", () => {
    if (!activeObject) return;
    activePage += 1;
    renderObject();
  });
  elements.pageSize.addEventListener("change", () => {
    pageSize = Number(elements.pageSize.value) || PAGE_SIZE;
    activePage = 0;
    renderObject();
  });
  elements.addFilter.addEventListener("click", addColumnFilter);
  elements.filterValue.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addColumnFilter();
  });
  elements.runQuery.addEventListener("click", runQuery);
  elements.explainQuery.addEventListener("click", explainQuery);
  elements.copyResults.addEventListener("click", () => {
    if (!lastQueryResult) return;
    window.tuic?.clipboard(formatCsv(lastQueryResult.columns, lastQueryResult.rows));
    window.tuic?.toast("Query results copied", { message: "CSV is ready on the clipboard", level: "info" });
  });
  elements.editMode.addEventListener("click", () => {
    editMode = !editMode;
    elements.editMode.textContent = editMode ? "Stop editing" : "Enable editing";
    renderObject();
  });
  elements.saveChanges.addEventListener("click", saveChanges);
  elements.query.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runQuery();
    }
  });
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "load-error") showFatal(message.message);
    if (message?.type === "save-result" && message.requestId === saveRequestId) finishSave(message);
    if (message?.type === "load-database" && message.databaseBuffer instanceof ArrayBuffer && message.wasmBuffer instanceof ArrayBuffer) {
      openDatabase(message);
    }
  });
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("beforeunload", dispose, { once: true });
  window.parent.postMessage({ type: "sqlite-viewer-ready" }, "*");
  async function openDatabase(message) {
    if (initializing) return;
    initializing = true;
    try {
      if (typeof window.initSqlJs !== "function") throw new Error("The bundled sql.js loader did not initialize.");
      const SQL = await window.initSqlJs({ wasmBinary: new Uint8Array(message.wasmBuffer) });
      if (!message.databaseBuffer.byteLength) throw new Error("The database buffer was released before initialization.");
      if (!hasSQLiteHeader(message.databaseBuffer)) {
        throw new Error(
          "The file has no standard SQLite header. It may be encrypted with SQLCipher, compressed, corrupt, or a different database format."
        );
      }
      database?.close();
      database = new SQL.Database(new Uint8Array(message.databaseBuffer));
      database.run("PRAGMA query_only=ON");
      databasePath = message.path;
      dirty = false;
      editRevision = 0;
      updateSaveUi();
      objects = queryRows(
        "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT ?",
        [MAX_OBJECTS]
      );
      elements.databaseMeta.textContent = message.path;
      elements.objectCount.textContent = `${objects.length}${objects.length === MAX_OBJECTS ? "+" : ""}`;
      elements.objectSummary.textContent = `${objects.length}${objects.length === MAX_OBJECTS ? "+" : ""} objects in this database`;
      elements.fatal.hidden = true;
      elements.workspace.hidden = false;
      renderObjects();
      if (objects[0]) selectObject(objects[0].name);
    } catch (error) {
      showFatal(`This file is not a readable SQLite database.
${errorMessage(error)}`);
    } finally {
      initializing = false;
    }
  }
  function renderObjects() {
    elements.objects.replaceChildren();
    if (!objects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No user tables or views";
      elements.objects.append(empty);
      return;
    }
    for (const object of objects) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sqlite-object${object.name === activeObject?.name ? " active" : ""}`;
      const name = document.createElement("span");
      name.className = "sqlite-object-name";
      name.textContent = object.name;
      button.append(name);
      const badge = document.createElement("span");
      badge.className = "badge badge-muted";
      badge.textContent = object.type;
      button.append(badge);
      button.addEventListener("click", () => selectObject(object.name));
      elements.objects.append(button);
    }
  }
  function selectObject(name) {
    activeObject = objects.find((object) => object.name === name) ?? null;
    activePage = 0;
    activeFilters = [];
    activeSort = null;
    editMode = false;
    renderObjects();
    renderObject();
  }
  function renderObject() {
    if (!database || !activeObject) return;
    try {
      const quoted = quoteIdentifier(activeObject.name);
      activeColumns = queryRows("SELECT * FROM pragma_table_xinfo(?)", [activeObject.name]).slice(0, MAX_COLUMNS);
      const primaryKeys = primaryKeyColumns();
      const canEdit = activeObject.type === "table" && primaryKeys.length > 0;
      elements.editMode.disabled = !canEdit;
      elements.editMode.title = canEdit ? "Edit non-key cells inline" : "Editing requires a table with a primary key";
      if (!canEdit) editMode = false;
      elements.editMode.textContent = editMode ? "Stop editing" : "Enable editing";
      syncFilterColumns();
      const filter = columnFilterWhere(activeFilters);
      const totalRows = Number(queryScalar(`SELECT count(*) FROM ${quoted}${filter.clause}`, filter.params) ?? 0);
      activePage = boundedPage(activePage, totalRows, pageSize);
      const offset = activePage * pageSize;
      const ordering = activeSort ? ` ORDER BY ${quoteIdentifier(activeSort.column)} ${activeSort.direction}` : "";
      const result = queryResult(`SELECT * FROM ${quoted}${filter.clause}${ordering} LIMIT ? OFFSET ?`, [
        ...filter.params,
        pageSize,
        offset
      ]);
      elements.objectTitle.textContent = `${activeObject.name} \xB7 ${activeObject.type}`;
      elements.schema.textContent = activeColumns.length ? activeColumns.map((column) => `${column.name} ${column.type || ""}${column.pk ? " PRIMARY KEY" : ""}`).join(" \xB7 ") : "No columns";
      elements.rowCount.textContent = totalRows.toLocaleString();
      elements.columnCount.textContent = activeColumns.length.toLocaleString();
      renderIndexes();
      renderFilters();
      renderTable(elements.rows, result.columns, result.rows, {
        sortable: true,
        editable: editMode,
        primaryKeys
      });
      const first = totalRows === 0 ? 0 : offset + 1;
      const last = Math.min(offset + pageSize, totalRows);
      elements.pageLabel.textContent = `${first.toLocaleString()}\u2013${last.toLocaleString()} of ${totalRows.toLocaleString()}`;
      elements.previous.disabled = activePage === 0;
      elements.next.disabled = offset + pageSize >= totalRows;
    } catch (error) {
      elements.rows.replaceChildren(errorNode(errorMessage(error)));
    }
  }
  function runQuery() {
    if (!database) return;
    elements.queryStatus.textContent = "Running\u2026";
    elements.queryStatus.className = "sqlite-status";
    elements.queryPlan.replaceChildren();
    lastQueryResult = null;
    elements.copyResults.disabled = true;
    try {
      const sql = validateQuery(elements.query.value);
      database.run("PRAGMA query_only=ON");
      const statement = singleStatement(database, sql);
      const columns = statement.getColumnNames().slice(0, MAX_COLUMNS);
      const rows = [];
      try {
        while (rows.length <= MAX_QUERY_ROWS && statement.step()) rows.push(statement.get().slice(0, MAX_COLUMNS));
      } finally {
        statement.free();
        database.run("PRAGMA query_only=ON");
      }
      const truncated = rows.length > MAX_QUERY_ROWS;
      if (truncated) rows.length = MAX_QUERY_ROWS;
      renderTable(elements.queryResults, columns, rows);
      lastQueryResult = { columns, rows };
      elements.copyResults.disabled = false;
      elements.queryStatus.textContent = `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}${truncated ? " \xB7 result truncated" : ""}`;
    } catch (error) {
      try {
        database.run("PRAGMA query_only=ON");
      } catch {
      }
      elements.queryStatus.textContent = errorMessage(error);
      elements.queryStatus.className = "sqlite-status sqlite-error";
      elements.queryResults.replaceChildren();
    }
  }
  function explainQuery() {
    if (!database) return;
    elements.queryStatus.textContent = "Building query plan\u2026";
    elements.queryStatus.className = "sqlite-status";
    elements.queryResults.replaceChildren();
    lastQueryResult = null;
    elements.copyResults.disabled = true;
    try {
      const sql = validateQuery(elements.query.value);
      const validated = singleStatement(database, sql);
      validated.free();
      const plan = queryRows(`EXPLAIN QUERY PLAN ${sql}`);
      renderQueryPlan(plan);
      elements.queryStatus.textContent = `${plan.length.toLocaleString()} plan step${plan.length === 1 ? "" : "s"}`;
    } catch (error) {
      elements.queryStatus.textContent = errorMessage(error);
      elements.queryStatus.className = "sqlite-status sqlite-error";
      elements.queryPlan.replaceChildren();
    }
  }
  function addColumnFilter() {
    const column = elements.filterColumn.value;
    const value = elements.filterValue.value;
    if (!column || !value) return;
    const existing = activeFilters.find((filter) => filter.column === column);
    if (existing) existing.value = value;
    else activeFilters.push({ column, value });
    elements.filterValue.value = "";
    activePage = 0;
    renderObject();
  }
  function syncFilterColumns() {
    const names = activeColumns.map((column) => column.name);
    const current = elements.filterColumn.value;
    if (elements.filterColumn.options.length === names.length && names.every((name, index) => elements.filterColumn.options[index]?.value === name)) {
      return;
    }
    elements.filterColumn.replaceChildren();
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      elements.filterColumn.append(option);
    }
    if (names.includes(current)) elements.filterColumn.value = current;
  }
  function renderFilters() {
    elements.filters.replaceChildren();
    if (!activeFilters.length) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "No column filters";
      elements.filters.append(hint);
      return;
    }
    for (const filter of activeFilters) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sqlite-filter-chip";
      const label = document.createElement("span");
      label.textContent = `${filter.column} contains \u201C${filter.value}\u201D`;
      button.append(label, document.createTextNode("\xD7"));
      button.title = "Remove filter";
      button.addEventListener("click", () => {
        activeFilters = activeFilters.filter((candidate) => candidate !== filter);
        activePage = 0;
        renderObject();
      });
      elements.filters.append(button);
    }
  }
  function renderIndexes() {
    elements.indexes.replaceChildren();
    if (activeObject.type !== "table") {
      elements.indexCount.textContent = "0";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Views do not own indexes.";
      elements.indexes.append(hint);
      return;
    }
    const indexes = queryRows('SELECT name, "unique" AS is_unique, partial FROM pragma_index_list(?) ORDER BY name', [
      activeObject.name
    ]);
    elements.indexCount.textContent = indexes.length.toLocaleString();
    if (!indexes.length) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "No explicit indexes";
      elements.indexes.append(hint);
      return;
    }
    for (const index of indexes) {
      const card = document.createElement("div");
      card.className = "card sqlite-index";
      const name = document.createElement("strong");
      name.textContent = index.name;
      const badge = document.createElement("span");
      badge.className = `badge ${index.is_unique ? "badge-accent" : "badge-muted"}`;
      badge.textContent = index.is_unique ? "UNIQUE" : index.partial ? "PARTIAL" : "INDEX";
      const columns = document.createElement("div");
      columns.className = "sqlite-index-columns";
      columns.textContent = queryRows("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [index.name]).map((column) => column.name).join(" \xB7 ");
      card.append(name, badge, columns);
      elements.indexes.append(card);
    }
  }
  function renderQueryPlan(plan) {
    elements.queryPlan.replaceChildren();
    const byId = new Map(plan.map((step) => [Number(step.id), step]));
    for (const step of plan) {
      let depth = 0;
      let parent = Number(step.parent);
      const seen = /* @__PURE__ */ new Set();
      while (parent && byId.has(parent) && !seen.has(parent) && depth < 12) {
        seen.add(parent);
        parent = Number(byId.get(parent).parent);
        depth += 1;
      }
      const card = document.createElement("div");
      card.className = "card sqlite-plan-step";
      card.style.setProperty("--depth", String(depth));
      const detail = document.createElement("div");
      detail.textContent = step.detail;
      const meta = document.createElement("div");
      meta.className = "sqlite-plan-meta";
      meta.textContent = `step ${step.id} \xB7 parent ${step.parent}`;
      card.append(detail, meta);
      elements.queryPlan.append(card);
    }
  }
  function queryRows(sql, params = []) {
    const result = queryResult(sql, params);
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
  }
  function queryScalar(sql, params = []) {
    return queryResult(sql, params).rows[0]?.[0];
  }
  function queryResult(sql, params = []) {
    const statement = database.prepare(sql);
    const rows = [];
    try {
      if (params.length) statement.bind(params);
      const columns = statement.getColumnNames();
      while (statement.step()) rows.push(statement.get());
      return { columns, rows };
    } finally {
      statement.free();
    }
  }
  function renderTable(container, columns, rows, options = {}) {
    container.replaceChildren();
    if (!columns.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = rows.length ? "Statement completed" : "No rows";
      container.append(empty);
      return;
    }
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      const direction = activeSort?.column === column ? activeSort.direction : null;
      cell.textContent = `${column}${direction === "ASC" ? " \u2191" : direction === "DESC" ? " \u2193" : ""}`;
      if (options.sortable) {
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.title = `Sort by ${column}`;
        const sort = () => {
          activeSort = {
            column,
            direction: activeSort?.column === column && activeSort.direction === "ASC" ? "DESC" : "ASC"
          };
          activePage = 0;
          renderObject();
        };
        cell.addEventListener("click", sort);
        cell.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") sort();
        });
      }
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tableRow = document.createElement("tr");
      for (let index = 0; index < columns.length; index++) {
        const formatted = formatCell(row[index]);
        const cell = document.createElement("td");
        cell.className = `sqlite-cell ${formatted.kind}`;
        cell.textContent = formatted.text;
        if (formatted.truncated) cell.title = String(row[index]);
        const definition = activeColumns.find((candidate) => candidate.name === columns[index]);
        const editable = options.editable && definition && !definition.pk && !definition.hidden && !(row[index] instanceof Uint8Array);
        if (editable) {
          cell.classList.add("editable");
          cell.title = "Double-click to edit";
          cell.addEventListener("dblclick", () => editCell(cell, definition, row[index], row, columns, options.primaryKeys));
        }
        tableRow.append(cell);
      }
      body.append(tableRow);
    }
    table.append(body);
    container.append(table);
  }
  function primaryKeyColumns() {
    return activeColumns.filter((column) => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk));
  }
  function editCell(cell, column, originalValue, row, resultColumns, primaryKeys) {
    if (cell.querySelector("input") || saving) return;
    const keyValues = primaryKeys.map((key) => {
      const index = resultColumns.indexOf(key.name);
      if (index < 0) throw new Error(`Primary key column ${key.name} is not present in this row.`);
      return row[index];
    });
    const input = document.createElement("input");
    input.className = "sqlite-cell-editor";
    input.value = originalValue == null ? "" : String(originalValue);
    if (originalValue == null) input.placeholder = "NULL";
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let finished = false;
    const cancel = () => {
      if (finished) return;
      finished = true;
      renderObject();
    };
    const commit = () => {
      if (finished) return;
      finished = true;
      try {
        const nextValue = coerceEditedValue(input.value, column.type, originalValue);
        if (Object.is(nextValue, originalValue)) {
          renderObject();
          return;
        }
        const table = quoteIdentifier(activeObject.name);
        const keyClause = primaryKeys.map((key) => `${quoteIdentifier(key.name)} IS ?`).join(" AND ");
        const sql = `UPDATE ${table} SET ${quoteIdentifier(column.name)} = ? WHERE ${keyClause}`;
        database.run("PRAGMA query_only=OFF");
        const statement = database.prepare(sql);
        try {
          statement.bind([nextValue, ...keyValues]);
          statement.step();
        } finally {
          statement.free();
        }
        if (database.getRowsModified() !== 1) throw new Error("The row changed or no longer exists.");
        dirty = true;
        editRevision += 1;
        updateSaveUi();
        renderObject();
      } catch (error) {
        window.tuic?.toast("SQLite edit failed", { message: errorMessage(error), level: "error" });
        renderObject();
      } finally {
        try {
          database.run("PRAGMA query_only=ON");
        } catch {
        }
      }
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") cancel();
    });
  }
  function saveChanges() {
    if (!database || !dirty || saving) return;
    saving = true;
    savingRevision = editRevision;
    saveRequestId += 1;
    updateSaveUi();
    try {
      const exported = database.export();
      database.run("PRAGMA query_only=ON");
      const buffer = exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength);
      window.parent.postMessage({ type: "save-database", requestId: saveRequestId, path: databasePath, buffer }, "*", [buffer]);
    } catch (error) {
      finishSave({ ok: false, message: errorMessage(error), requestId: saveRequestId });
    }
  }
  function finishSave(message) {
    saving = false;
    lastQueryResult = null;
    if (message.ok && savingRevision === editRevision) dirty = false;
    updateSaveUi();
    if (message.ok) {
      window.tuic?.toast("SQLite database saved", { message: databasePath, level: "info" });
    } else {
      window.tuic?.toast("SQLite save failed", { message: message.message || "Unknown error", level: "error" });
    }
  }
  function updateSaveUi() {
    elements.dirtyState.hidden = !dirty;
    elements.dirtyState.textContent = saving ? "SAVING\u2026" : "UNSAVED";
    elements.saveChanges.disabled = !dirty || saving;
    elements.saveChanges.textContent = saving ? "Saving\u2026" : "Save changes";
    const canEdit = activeObject?.type === "table" && primaryKeyColumns().length > 0;
    elements.editMode.disabled = saving || !canEdit;
  }
  function showFatal(message) {
    database?.close();
    database = null;
    elements.workspace.hidden = true;
    elements.fatal.hidden = false;
    elements.fatal.replaceChildren(errorNode(message));
  }
  function errorNode(message) {
    const node = document.createElement("div");
    node.className = "sqlite-error";
    node.textContent = message;
    return node;
  }
  function dispose() {
    database?.close();
    database = null;
    objects = [];
    activeObject = null;
    activeColumns = [];
    activeFilters = [];
    activeSort = null;
    databasePath = "";
    dirty = false;
    saving = false;
    initializing = false;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
