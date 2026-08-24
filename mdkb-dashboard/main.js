/**
 * mdkb Dashboard Plugin
 *
 * Displays the mdkb knowledge base index, collections, memories, code index,
 * session usage, and hook health for the active repository in an interactive
 * HTML panel, and exposes one-click maintenance actions (reindex, code rebuild,
 * re-embed, compact).
 *
 * All data comes from a single `mdkb --format json stats` call plus
 * `mdkb --format json memory list`. The old `status` CLI subcommand was removed
 * upstream (mdkb ≥ 3.x) — `stats` now carries index + collections + code +
 * sessions + hooks. Field paths mirror `src/cli/stats_report.rs` in the mdkb
 * repo; keep them in sync if that struct changes.
 *
 * Capabilities required:
 *   - exec:cli     (run `mdkb --format json <cmd>`, incl. mutating update/embed/compact)
 *   - fs:read      (read .mdkb/config.toml)
 *   - ui:panel     (render HTML dashboard)
 *   - ui:ticker    (show compact status in status bar)
 */

const PLUGIN_ID = "mdkb-dashboard";

const DB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5c0-1.865 2.91-3 6-3s6 1.135 6 3v9c0 1.865-2.91 3-6 3s-6-1.135-6-3v-9zm1.156 4.843C3.328 9.372 5.089 10 7 10s3.672-.628 4.844-1.657v2.157c0 .828-1.89 2-5.344 2S1.5 11.328 1.5 10.5V8.343h.156-.5.5zm0 4C3.328 13.372 5.089 14 7 14s3.672-.628 4.844-1.657V14.5c0 .828-1.89 2-5.344 2S1.5 15.328 1.5 14.5v-2.157h.156-.5.5zM7 1.5c-3.454 0-5.344 1.172-5.344 2S3.546 5.5 7 5.5s5.344-1.172 5.344-2S10.454 1.5 7 1.5zM2.156 4.843C3.328 5.872 5.089 6.5 7 6.5s3.672-.628 4.844-1.657V6.5c0 .828-1.89 2-5.344 2S1.5 7.328 1.5 6.5V4.843h.156-.5.5z"/></svg>`;

/**
 * Maintenance actions surfaced as header buttons. `argv` is appended after
 * `["--format", "json"]` (except compact, which ignores --format). `json:false`
 * means stdout is not a single parseable JSON document — we run fire-and-forget
 * and re-read state from `stats` afterwards.
 */
const ACTIONS = {
  update: { label: "Reindex", argv: ["update"], json: false, slow: true },
  "update-force": { label: "Force reindex", argv: ["update", "--force"], json: false, slow: true },
  "code-force": { label: "Rebuild code", argv: ["code", "index", "--force"], json: true, slow: true },
  embed: { label: "Re-embed", argv: ["embed"], json: true, slow: true },
  compact: { label: "Compact", argv: ["compact"], json: false, slow: true, noFormat: true },
};

let hostRef = null;
let panelRef = null;
let lastData = null; // last fetched { stats, memories, config, error }

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchMdkbData(host, repoPath) {
  const data = { stats: null, memories: null, config: null, error: null };

  // stats and memory list are independent — one failing must not blank the
  // whole dashboard (the old Promise.all did exactly that when `status` broke).
  const [statsRes, memRes] = await Promise.allSettled([
    host.execCli("mdkb", ["--format", "json", "stats"], repoPath),
    host.execCli("mdkb", ["--format", "json", "memory", "list"], repoPath),
  ]);

  if (statsRes.status === "fulfilled") {
    try {
      data.stats = JSON.parse(statsRes.value);
    } catch (err) {
      data.error = `Could not parse mdkb stats: ${err.message || err}`;
    }
  } else {
    data.error = statsRes.reason?.message || String(statsRes.reason);
    host.log("warn", "mdkb stats failed", { error: data.error });
  }

  if (memRes.status === "fulfilled") {
    try {
      const parsed = JSON.parse(memRes.value);
      data.memories = Array.isArray(parsed) ? parsed : [];
    } catch {
      data.memories = [];
    }
  }

  // Config is optional — absent before `mdkb init`.
  try {
    data.config = await host.readFile(`${repoPath}/.mdkb/config.toml`);
  } catch {
    data.config = null;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function relativeTime(unixTs) {
  if (!unixTs) return "never";
  const diff = Date.now() / 1000 - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function statCard(value, label, extra = "") {
  return `
    <div class="dash-stat">
      <div class="dash-stat-label">${label}</div>
      <div class="dash-stat-value">${value}</div>
      ${extra}
    </div>`;
}

const BADGE_BY_TYPE = {
  problem: "badge-error",
  decision: "badge-accent",
  topic: "badge-success",
  handoff: "badge-muted",
  reminder: "badge-warn",
};

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

// Exported for unit testing — the plugin loader only reads `.default`, so this
// named export is inert at runtime (same pattern as build-cleaner).
export function renderDashboard(data, repoPath, opts = {}) {
  const { stats, memories, config, error } = data;
  const repoName = repoPath.split("/").pop();

  if (error && !stats) {
    return buildPage(repoName, null, `
      <div class="dash-section">
        <div class="empty-state">
          <h2>mdkb not available</h2>
          <p>${esc(error)}</p>
          <p class="hint">Make sure <code>mdkb</code> is installed and the project was initialized with <code>mdkb init</code>.</p>
        </div>
      </div>
    `);
  }

  const sections = [];
  const header = stats?.header || {};

  // --- Overview (index) ---
  if (stats?.index) {
    const idx = stats.index;
    const collCount = stats.collections?.collections?.length ?? 0;
    const fragPct = Math.round((idx.free_page_ratio || 0) * 100);
    const fragExtra = fragPct >= 20
      ? `<div class="dash-stat-sub warn">${fragPct}% free pages — Compact to reclaim</div>`
      : `<div class="dash-stat-sub">${fragPct}% free pages</div>`;
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Index
          <span class="dash-section-hint">Updated ${relativeTime(header.last_updated)}</span>
        </h2>
        <div class="dash-stat-grid">
          ${statCard(idx.document_count ?? "—", "Documents")}
          ${statCard(idx.memory_count ?? "—", "Memories")}
          ${statCard(collCount, "Collections")}
          ${statCard(formatBytes(header.db_size_bytes), "DB Size", fragExtra)}
        </div>
      </div>
    `);
  }

  // --- Collections ---
  const collections = stats?.collections?.collections || [];
  if (collections.length > 0) {
    const rows = collections.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><code>${esc(c.path)}</code></td>
        <td><code>${esc(c.pattern)}</code></td>
        <td class="num">${c.doc_count ?? 0}</td>
      </tr>
    `).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Collections</h2>
        <table>
          <thead><tr><th>Name</th><th>Path</th><th>Pattern</th><th class="num">Docs</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Memory health + entries ---
  if (stats?.memory) {
    const m = stats.memory;
    const byType = m.counts_by_type || {};
    const typeBadges = Object.keys(byType).sort((a, b) => byType[b] - byType[a]).map((t) =>
      `<span class="badge ${BADGE_BY_TYPE[t] || "badge-muted"}">${esc(t)} ${byType[t]}</span>`
    ).join(" ");
    const remind = m.reminders_due > 0
      ? `<span class="badge badge-warn">${m.reminders_due} due</span>` : "";
    const remindUp = m.reminders_upcoming_7d > 0
      ? `<span class="badge badge-muted">${m.reminders_upcoming_7d} upcoming 7d</span>` : "";
    const pending = m.pending_embeddings > 0
      ? `<span class="badge badge-warn">${m.pending_embeddings} pending embeddings</span>` : "";

    const memRows = (memories || []).slice(0, 30).map((mem) => {
      const badgeClass = BADGE_BY_TYPE[mem.entry_type] || "badge-muted";
      const tags = (mem.tags || []).map((t) => `<span class="badge badge-muted">${esc(t)}</span>`).join(" ");
      return `
        <tr>
          <td><code>${esc(mem.id)}</code></td>
          <td>${esc(mem.title)}</td>
          <td><span class="badge ${badgeClass}">${esc(mem.entry_type)}</span></td>
          <td class="num">${mem.access_count || 0}</td>
          <td>${tags}</td>
        </tr>`;
    }).join("");

    const memTable = (memories && memories.length > 0) ? `
      <table>
        <thead><tr><th>ID</th><th>Title</th><th>Type</th><th class="num">Hits</th><th>Tags</th></tr></thead>
        <tbody>${memRows}</tbody>
      </table>` : `<div class="empty-state">No memory entries yet.</div>`;

    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Memory
          <span class="dash-section-hint">${m.active_count ?? 0} active${memories && memories.length > 30 ? " · showing 30" : ""}</span>
        </h2>
        <div class="badge-row">${typeBadges} ${remind} ${remindUp} ${pending}</div>
        ${memTable}
      </div>
    `);
  }

  // --- Code index ---
  if (stats?.code) {
    const c = stats.code;
    const langRows = (c.languages || []).map((l) =>
      `<tr><td>${esc(l.language)}</td><td class="num">${l.files}</td><td class="num">${l.symbols}</td></tr>`
    ).join("");
    const kindBadges = (c.symbols_by_kind || []).slice(0, 8).map((k) =>
      `<span class="badge badge-muted">${esc(k.kind)} ${k.count}</span>`
    ).join(" ");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Code Index
          <span class="dash-section-hint">Indexed ${relativeTime(c.last_indexed)}</span>
        </h2>
        <div class="dash-stat-grid">
          ${statCard(c.files ?? "—", "Files")}
          ${statCard(c.symbols ?? "—", "Symbols")}
          ${statCard(c.relations ?? "—", "Relations")}
        </div>
        ${kindBadges ? `<div class="badge-row">${kindBadges}</div>` : ""}
        ${langRows ? `<table>
          <thead><tr><th>Language</th><th class="num">Files</th><th class="num">Symbols</th></tr></thead>
          <tbody>${langRows}</tbody>
        </table>` : ""}
      </div>
    `);
  }

  // --- Session usage ---
  if (stats?.sessions) {
    const s = stats.sessions;
    const toolRows = (s.top_tools || []).slice(0, 8).map((t) =>
      `<tr><td><code>${esc(t.tool_name)}</code></td><td class="num">${t.call_count}</td></tr>`
    ).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Session Usage</h2>
        <div class="dash-stat-grid">
          ${statCard(s.total_sessions ?? 0, "Sessions")}
          ${statCard(s.total_calls ?? 0, "Tool Calls")}
        </div>
        ${toolRows ? `<table>
          <thead><tr><th>Tool</th><th class="num">Calls</th></tr></thead>
          <tbody>${toolRows}</tbody>
        </table>` : ""}
      </div>
    `);
  }

  // --- Hook health ---
  if (stats?.hooks?.events?.length) {
    const h = stats.hooks;
    const rows = h.events.map((e) =>
      `<tr>
        <td><code>${esc(e.event)}</code></td>
        <td class="num">${e.invocations}</td>
        <td class="num">${e.fired}</td>
        <td class="num">${e.avg_ms}</td>
        <td class="num">${e.p95_ms}</td>
      </tr>`
    ).join("");
    const mining = h.mining
      ? `<span class="badge ${h.mining.enabled ? "badge-success" : "badge-muted"}">mining ${h.mining.enabled ? "on" : "off"}${h.mining.reason ? " · " + esc(h.mining.reason) : ""}</span>`
      : "";
    const slow = h.slow_events_7d > 0 ? `<span class="badge badge-warn">${h.slow_events_7d} slow (7d)</span>` : "";
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Hooks</h2>
        <div class="badge-row">${mining} ${slow}</div>
        <table>
          <thead><tr><th>Event</th><th class="num">Calls</th><th class="num">Fired</th><th class="num">Avg ms</th><th class="num">p95 ms</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Config ---
  if (config) {
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Configuration
          <span class="dash-section-hint">.mdkb/config.toml</span>
        </h2>
        <pre class="config-block">${esc(config)}</pre>
      </div>
    `);
  }

  return buildPage(repoName, header.version, sections.join("\n"), opts);
}

function actionBar(opts) {
  const running = opts.running || null;
  const banner = opts.lastResult
    ? `<div class="run-banner ${opts.lastResult.ok ? "ok" : "err"}">${esc(opts.lastResult.text)}</div>`
    : running
      ? `<div class="run-banner running">⏳ ${esc(ACTIONS[running]?.label || running)} running… this can take a while</div>`
      : "";

  const btns = Object.entries(ACTIONS).map(([id, a]) => {
    const isRunning = running === id;
    const disabled = running ? " disabled" : "";
    return `<button data-act="${id}" class="act"${disabled}>${isRunning ? "Running…" : esc(a.label)}</button>`;
  }).join("");

  return { banner, btns };
}

function buildPage(repoName, version, body, opts = {}) {
  const { banner, btns } = actionBar(opts);
  const verTag = version ? `<span class="version">v${esc(version)}</span>` : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Plugin-specific tweaks only — layout/cards/typography come from
     PLUGIN_BASE_CSS (.dashboard, .dash-*). See docs/plugins-style.md. */
  pre.config-block {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .dash-title .repo-name { color: var(--accent); margin-left: 4px; }
  .dash-title .version { color: var(--fg-muted); font-size: 11px; margin-left: 6px; font-weight: 400; }
  .dash-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  button.act {
    background: transparent; color: var(--fg-secondary);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 3px 10px; font-size: 11px; cursor: pointer;
  }
  button.act:hover:not(:disabled) { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  .dash-stat-sub { font-size: 10px; color: var(--fg-muted); margin-top: 2px; }
  .dash-stat-sub.warn { color: var(--warning); }
  .badge-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .run-banner { padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 10px; border: 1px solid var(--border); }
  .run-banner.ok { color: var(--success); border-color: var(--success); }
  .run-banner.err { color: var(--error); border-color: var(--error); }
  .run-banner.running { color: var(--fg-secondary); }
</style>
</head>
<body>
<div class="dashboard">
  <div class="dash-header">
    <h1 class="dash-title">mdkb <span class="repo-name">${esc(repoName)}</span>${verTag}</h1>
    <div class="dash-actions">${btns}</div>
  </div>
  ${banner}
  ${body}
</div>
<script>
  const post = (m) => window.parent.postMessage(m, "*");
  document.querySelectorAll("button.act").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      document.querySelectorAll("button.act").forEach((b) => { b.disabled = true; });
      btn.textContent = "Running…";
      post({ action: "run", cmd: btn.dataset.act });
    });
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function updateTicker(host, stats) {
  if (!stats?.index) {
    host.clearTicker("mdkb-status");
    return;
  }
  const idx = stats.index;
  const collCount = stats.collections?.collections?.length ?? 0;
  const symbols = stats.code?.symbols;
  const codePart = symbols ? ` · ${symbols} sym` : "";
  const pending = stats.memory?.pending_embeddings > 0 ? ` · ${stats.memory.pending_embeddings} unembedded` : "";
  host.setTicker({
    id: "mdkb-status",
    text: `${idx.document_count} docs · ${collCount} coll${codePart}${pending}`,
    label: "mdkb",
    icon: DB_ICON,
    priority: 5, // low tier — popover only
    ttlMs: 0, // persistent until cleared
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Run a maintenance action, then re-fetch state and re-render. */
async function runAction(host, repo, cmdId) {
  const action = ACTIONS[cmdId];
  if (!action) return;

  // Show the running state immediately (buttons disabled + banner).
  renderPanel(lastData, repo.path, { running: cmdId });

  let lastResult;
  try {
    const argv = action.noFormat ? action.argv : ["--format", "json", ...action.argv];
    const out = await host.execCli("mdkb", argv, repo.path);
    lastResult = { ok: true, text: `✓ ${action.label}: ${summarizeResult(cmdId, out)}` };
    host.log("info", `mdkb ${action.argv.join(" ")} completed`);
  } catch (err) {
    lastResult = { ok: false, text: `✗ ${action.label} failed: ${err.message || err}` };
    host.log("error", `mdkb ${action.argv.join(" ")} failed`, { error: String(err) });
  }

  lastData = await fetchMdkbData(host, repo.path);
  renderPanel(lastData, repo.path, { lastResult });
  updateTicker(host, lastData.stats);
}

/** Short human summary of an action's stdout. `update`/`compact` have no clean
 *  JSON, so we just confirm completion; embed/code-force emit parseable JSON. */
function summarizeResult(cmdId, out) {
  try {
    if (cmdId === "embed") {
      const r = JSON.parse(out);
      return `${r.generated ?? 0} generated, ${r.skipped ?? 0} skipped`;
    }
    if (cmdId === "code-force") {
      const r = JSON.parse(out);
      return `${r.files_indexed ?? 0} files, ${r.symbols_indexed ?? 0} symbols`;
    }
  } catch {
    // fall through to generic
  }
  return "done";
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

/**
 * Push a render into the open panel. update() returns false once the user has
 * closed the tab; that decision sticks, so we drop the handle instead of
 * re-opening a panel nobody asked for.
 */
function renderPanel(data, repoPath, opts = {}) {
  if (!panelRef) return;
  if (!panelRef.update(renderDashboard(data, repoPath, opts))) panelRef = null;
}

async function handlePanelMessage(msg) {
  if (!msg || msg.action !== "run") return;
  const repo = hostRef.getActiveRepo();
  if (!repo) return;
  await runAction(hostRef, repo, msg.cmd);
}

async function openDashboard(host) {
  const repo = host.getActiveRepo();
  if (!repo) {
    const html = buildPage("(none)", null, `
      <div class="dash-section">
        <div class="empty-state">
          <h2>No active repository</h2>
          <p>Select a repository in the sidebar to view its mdkb status.</p>
        </div>
      </div>
    `);
    // openPanel reuses and activates the panel with this id when one is open,
    // so the user always ends up looking at it — no update/re-open dance.
    panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html, onMessage: handlePanelMessage });
    return;
  }

  // Open instantly with a loading placeholder, then fetch.
  const loading = buildPage(repo.displayName, null, `
    <div class="dash-section"><div class="empty-state">Loading mdkb data for ${esc(repo.displayName)}…</div></div>
  `);
  panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html: loading, onMessage: handlePanelMessage });

  lastData = await fetchMdkbData(host, repo.path);
  renderPanel(lastData, repo.path);
  updateTicker(host, lastData.stats);
}

async function refreshTicker(host) {
  const repo = host.getActiveRepo();
  if (!repo) {
    host.clearTicker("mdkb-status");
    return;
  }
  try {
    const out = await host.execCli("mdkb", ["--format", "json", "stats"], repo.path);
    updateTicker(host, JSON.parse(out));
  } catch {
    host.clearTicker("mdkb-status");
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    host.registerTerminalAction({
      id: "open-mdkb-dashboard",
      label: "mdkb Dashboard",
      action: () => openDashboard(host),
    });

    host.registerDashboard({
      label: "mdkb",
      icon: DB_ICON,
      open: () => openDashboard(host),
    });

    refreshTicker(host);
  },

  onunload() {
    hostRef?.clearTicker("mdkb-status");
    hostRef = null;
    panelRef = null;
    lastData = null;
  },
};
