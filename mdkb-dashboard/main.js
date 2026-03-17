/**
 * mdkb Dashboard Plugin
 *
 * Displays the mdkb knowledge base status, collections, memories, stats,
 * and configuration for the active repository in an interactive HTML panel.
 *
 * Capabilities required:
 *   - exec:cli     (run `mdkb --format json status/stats/memory list`)
 *   - fs:read      (read .mdkb/config.toml)
 *   - ui:panel     (render HTML dashboard)
 *   - ui:ticker    (show compact status in status bar)
 */

const PLUGIN_ID = "mdkb-dashboard";
const SECTION_ID = "mdkb";

const DB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5c0-1.865 2.91-3 6-3s6 1.135 6 3v9c0 1.865-2.91 3-6 3s-6-1.135-6-3v-9zm1.156 4.843C3.328 9.372 5.089 10 7 10s3.672-.628 4.844-1.657v2.157c0 .828-1.89 2-5.344 2S1.5 11.328 1.5 10.5V8.343h.156-.5.5zm0 4C3.328 13.372 5.089 14 7 14s3.672-.628 4.844-1.657V14.5c0 .828-1.89 2-5.344 2S1.5 15.328 1.5 14.5v-2.157h.156-.5.5zM7 1.5c-3.454 0-5.344 1.172-5.344 2S3.546 5.5 7 5.5s5.344-1.172 5.344-2S10.454 1.5 7 1.5zM2.156 4.843C3.328 5.872 5.089 6.5 7 6.5s3.672-.628 4.844-1.657V6.5c0 .828-1.89 2-5.344 2S1.5 7.328 1.5 6.5V4.843h.156-.5.5z"/></svg>`;

let hostRef = null;
let panelRef = null;

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchMdkbData(host, repoPath) {
  const results = { status: null, stats: null, memories: null, codeInfo: null, config: null, error: null };

  try {
    const [statusRaw, statsRaw, memoriesRaw] = await Promise.all([
      host.execCli("mdkb", ["--format", "json", "status"], repoPath),
      host.execCli("mdkb", ["--format", "json", "stats"], repoPath),
      host.execCli("mdkb", ["--format", "json", "memory", "list"], repoPath),
    ]);
    results.status = JSON.parse(statusRaw);
    results.stats = JSON.parse(statsRaw);
    results.memories = JSON.parse(memoriesRaw);
  } catch (err) {
    results.error = err.message || String(err);
    host.log("warn", "Failed to fetch mdkb data", { error: results.error });
  }

  // Code index info (may not exist)
  try {
    const codeRaw = await host.execCli("mdkb", ["--format", "json", "code", "info"], repoPath);
    results.codeInfo = JSON.parse(codeRaw);
  } catch {
    results.codeInfo = null;
  }

  // Read config separately (may not exist)
  try {
    const configPath = `${repoPath}/.mdkb/config.toml`;
    results.config = await host.readFile(configPath);
  } catch {
    results.config = null;
  }

  return results;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function formatDate(unixTs) {
  if (!unixTs) return "—";
  const d = new Date(unixTs * 1000);
  return d.toLocaleString();
}

function relativeTime(unixTs) {
  if (!unixTs) return "";
  const now = Date.now() / 1000;
  const diff = now - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function renderDashboard(data, repoPath) {
  const { status, stats, memories, config, error } = data;
  const repoName = repoPath.split("/").pop();

  if (error && !status) {
    return buildPage(repoName, `
      <div class="card error-card">
        <h2>mdkb not available</h2>
        <p>${esc(error)}</p>
        <p class="hint">Make sure <code>mdkb</code> is installed and the project has been initialized with <code>mdkb init</code>.</p>
      </div>
    `);
  }

  const sections = [];

  // --- Overview card ---
  if (status) {
    const idx = status.index;
    sections.push(`
      <div class="card">
        <h2>Index Overview</h2>
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-value">${idx.documents}</span>
            <span class="stat-label">Documents</span>
          </div>
          <div class="stat">
            <span class="stat-value">${idx.stale_documents}</span>
            <span class="stat-label">Stale</span>
          </div>
          <div class="stat">
            <span class="stat-value">${idx.collections}</span>
            <span class="stat-label">Collections</span>
          </div>
          <div class="stat">
            <span class="stat-value">${formatBytes(idx.db_size_bytes)}</span>
            <span class="stat-label">DB Size</span>
          </div>
        </div>
        <p class="last-updated">Last updated: ${formatDate(idx.last_updated)} <span class="muted">(${relativeTime(idx.last_updated)})</span></p>
      </div>
    `);
  }

  // --- Collections card ---
  if (status && status.collections && status.collections.length > 0) {
    const rows = status.collections.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="mono">${esc(c.path)}</td>
        <td class="mono">${esc(c.pattern)}</td>
        <td class="right">${c.doc_count}</td>
        <td><span class="badge badge-${c.source}">${esc(c.source)}</span></td>
      </tr>
    `).join("");

    sections.push(`
      <div class="card">
        <h2>Collections</h2>
        <table>
          <thead><tr><th>Name</th><th>Path</th><th>Pattern</th><th class="right">Docs</th><th>Source</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Memories card ---
  if (memories && memories.length > 0) {
    const rows = memories.slice(0, 30).map((m) => {
      const typeBadge = { problem: "red", decision: "blue", topic: "green" }[m.entry_type] || "gray";
      const tags = (m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ");
      return `
        <tr>
          <td class="mono">${esc(m.id)}</td>
          <td>${esc(m.title)}</td>
          <td><span class="badge badge-type-${typeBadge}">${esc(m.entry_type)}</span></td>
          <td class="right">${m.access_count || 0}</td>
          <td class="tags-cell">${tags}</td>
        </tr>
      `;
    }).join("");

    sections.push(`
      <div class="card">
        <h2>Memories <span class="count">(${memories.length})</span></h2>
        <table>
          <thead><tr><th>ID</th><th>Title</th><th>Type</th><th class="right">Hits</th><th>Tags</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${memories.length > 30 ? `<p class="hint">Showing 30 of ${memories.length} entries.</p>` : ""}
      </div>
    `);
  }

  // --- Code Index card ---
  if (data.codeInfo) {
    const ci = data.codeInfo;
    sections.push(`
      <div class="card">
        <h2>Code Index</h2>
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-value">${ci.files}</span>
            <span class="stat-label">Files</span>
          </div>
          <div class="stat">
            <span class="stat-value">${ci.symbols}</span>
            <span class="stat-label">Symbols</span>
          </div>
          <div class="stat">
            <span class="stat-value">${ci.relationships}</span>
            <span class="stat-label">Relationships</span>
          </div>
        </div>
      </div>
    `);
  }

  // --- Stats card ---
  if (stats) {
    const agg = stats.aggregate;
    const recentSessions = (stats.sessions || []).filter((s) => s.total_calls > 0).slice(0, 5);

    sections.push(`
      <div class="card">
        <h2>Usage Stats</h2>
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-value">${agg.total_sessions}</span>
            <span class="stat-label">Sessions</span>
          </div>
          <div class="stat">
            <span class="stat-value">${agg.total_calls}</span>
            <span class="stat-label">Total Calls</span>
          </div>
          <div class="stat">
            <span class="stat-value">${agg.total_tokens.toLocaleString()}</span>
            <span class="stat-label">Tokens</span>
          </div>
          <div class="stat">
            <span class="stat-value">${agg.avg_tokens_per_call.toFixed(1)}</span>
            <span class="stat-label">Avg Tok/Call</span>
          </div>
        </div>
        ${recentSessions.length > 0 ? `
          <h3>Recent Active Sessions</h3>
          <table class="compact">
            <thead><tr><th>Session</th><th>Started</th><th class="right">Calls</th><th class="right">Tokens</th><th>Tools</th></tr></thead>
            <tbody>
              ${recentSessions.map((s) => `
                <tr>
                  <td>#${s.id}</td>
                  <td>${formatDate(s.started_at)} <span class="muted">(${relativeTime(s.started_at)})</span></td>
                  <td class="right">${s.total_calls}</td>
                  <td class="right">${s.total_tokens.toLocaleString()}</td>
                  <td class="mono">${(s.tool_usage || []).map((t) => `${t.tool_name}:${t.call_count}`).join(", ") || "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}
      </div>
    `);
  }

  // --- Config card ---
  if (config) {
    sections.push(`
      <div class="card">
        <h2>Configuration <span class="muted mono">.mdkb/config.toml</span></h2>
        <pre class="config-block">${esc(config)}</pre>
      </div>
    `);
  }

  return buildPage(repoName, sections.join("\n"));
}

function buildPage(repoName, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Plugin-specific — base styles inherited from TUICommander */
  .dashboard {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px 20px 40px;
  }
  h1 {
    font-size: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h1 .repo-name { color: var(--accent, #59a8dd); }
  h2 .count { font-weight: 400; color: var(--fg-muted, #9aa1a9); }
  h3 {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
  }
  .card {
    padding: 16px;
    margin-bottom: 12px;
  }
  .error-card {
    border-color: var(--error, #f48771);
    background: color-mix(in srgb, var(--error) 10%, var(--bg-primary));
  }
  .error-card h2 { color: var(--error, #f48771); }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 12px;
    margin-bottom: 8px;
  }
  .stat {
    text-align: center;
    padding: 8px;
    background: var(--bg-primary, #1e1e1e);
    border-radius: 4px;
    border: 1px solid var(--border, #3e3e42);
  }
  .stat-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: var(--accent, #59a8dd);
  }
  .stat-label {
    display: block;
    font-size: 11px;
    color: var(--fg-muted, #9aa1a9);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }
  table.compact { font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  .right { text-align: right; }
  .mono { font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace; font-size: 11px; }
  .muted { color: var(--fg-muted, #9aa1a9); }
  .badge {
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .badge-manual { background: var(--bg-tertiary, #2d2d30); color: var(--fg-muted, #9aa1a9); }
  .badge-convention { background: color-mix(in srgb, var(--success) 15%, var(--bg-primary)); color: var(--success, #4ec9b0); }
  .badge-library { background: color-mix(in srgb, var(--accent) 15%, var(--bg-primary)); color: var(--accent, #59a8dd); }
  .badge-sessions { background: color-mix(in srgb, var(--merged, #a371f7) 15%, var(--bg-primary)); color: var(--merged, #a371f7); }
  .badge-type-red { background: color-mix(in srgb, var(--error) 15%, var(--bg-primary)); color: var(--error, #f48771); }
  .badge-type-blue { background: color-mix(in srgb, var(--accent) 15%, var(--bg-primary)); color: var(--accent, #59a8dd); }
  .badge-type-green { background: color-mix(in srgb, var(--success) 15%, var(--bg-primary)); color: var(--success, #4ec9b0); }
  .badge-type-gray { background: var(--bg-tertiary, #2d2d30); color: var(--fg-muted, #9aa1a9); }
  .tag {
    display: inline-block;
    font-size: 10px;
    padding: 0 4px;
    background: var(--bg-tertiary, #2d2d30);
    color: var(--fg-muted, #9aa1a9);
    border-radius: 3px;
    margin-right: 3px;
    margin-bottom: 2px;
  }
  .tags-cell { max-width: 200px; }
  .last-updated {
    font-size: 11px;
    color: var(--fg-muted, #9aa1a9);
    margin-top: 8px;
  }
  pre.config-block {
    background: var(--bg-primary, #1e1e1e);
    border: 1px solid var(--border, #3e3e42);
    border-radius: 4px;
    padding: 12px;
    font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .icon-inline {
    width: 16px;
    height: 16px;
    vertical-align: middle;
    fill: var(--accent, #59a8dd);
  }
</style>
</head>
<body>
<div class="dashboard">
  <h1>
    <svg class="icon-inline" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5c0-1.865 2.91-3 6-3s6 1.135 6 3v9c0 1.865-2.91 3-6 3s-6-1.135-6-3v-9zm1.156 4.843C3.328 9.372 5.089 10 7 10s3.672-.628 4.844-1.657v2.157c0 .828-1.89 2-5.344 2S1.5 11.328 1.5 10.5V8.343h.156-.5.5zm0 4C3.328 13.372 5.089 14 7 14s3.672-.628 4.844-1.657V14.5c0 .828-1.89 2-5.344 2S1.5 15.328 1.5 14.5v-2.157h.156-.5.5zM7 1.5c-3.454 0-5.344 1.172-5.344 2S3.546 5.5 7 5.5s5.344-1.172 5.344-2S10.454 1.5 7 1.5zM2.156 4.843C3.328 5.872 5.089 6.5 7 6.5s3.672-.628 4.844-1.657V6.5c0 .828-1.89 2-5.344 2S1.5 7.328 1.5 6.5V4.843h.156-.5.5z"/></svg>
    mdkb · <span class="repo-name">${esc(repoName)}</span>
  </h1>
  ${body}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function updateTicker(host, status, codeInfo) {
  if (!status || !status.index) {
    host.clearTicker("mdkb-status");
    return;
  }
  const idx = status.index;
  const staleTag = idx.stale_documents > 0 ? ` (${idx.stale_documents} stale)` : "";
  const codePart = codeInfo ? ` · ${codeInfo.symbols} sym` : "";
  host.setTicker({
    id: "mdkb-status",
    text: `${idx.documents} docs · ${idx.collections} coll${staleTag}${codePart}`,
    label: "mdkb",
    icon: DB_ICON,
    priority: 5, // low tier — popover only
    ttlMs: 0,    // persistent until cleared
  });
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    // Activity Center section
    host.registerSection({
      id: SECTION_ID,
      label: "KNOWLEDGE BASE",
      priority: 50,
      canDismissAll: false,
    });

    // Persistent activity item to open the dashboard
    host.addItem({
      id: "mdkb:dashboard",
      pluginId: PLUGIN_ID,
      sectionId: SECTION_ID,
      title: "mdkb Dashboard",
      subtitle: "View knowledge base status",
      icon: DB_ICON,
      dismissible: false,
      onClick: () => openDashboard(host),
    });

    // Initial ticker update
    refreshTicker(host);
  },

  onunload() {
    hostRef = null;
    panelRef = null;
  },
};

async function openDashboard(host) {
  const repo = host.getActiveRepo();
  if (!repo) {
    const html = buildPage("(none)", `
      <div class="card error-card">
        <h2>No active repository</h2>
        <p>Select a repository in the sidebar to view its mdkb status.</p>
      </div>
    `);
    if (panelRef) {
      panelRef.update(html);
    } else {
      panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html });
    }
    return;
  }

  // Show loading state
  const loadingHtml = buildPage(repo.displayName, `
    <div class="card">
      <h2>Loading...</h2>
      <p class="hint">Fetching mdkb data for ${esc(repo.displayName)}...</p>
    </div>
  `);

  if (panelRef) {
    panelRef.update(loadingHtml);
  } else {
    panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html: loadingHtml });
  }

  const data = await fetchMdkbData(host, repo.path);
  const html = renderDashboard(data, repo.path);

  try {
    panelRef.update(html);
  } catch {
    // Panel may have been closed, re-open
    panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html });
  }

  // Also update ticker with latest data
  if (data.status) {
    updateTicker(host, data.status, data.codeInfo);
  }
}

async function refreshTicker(host) {
  const repo = host.getActiveRepo();
  if (!repo) {
    host.clearTicker("mdkb-status");
    return;
  }

  try {
    const [statusRaw, codeRaw] = await Promise.allSettled([
      host.execCli("mdkb", ["--format", "json", "status"], repo.path),
      host.execCli("mdkb", ["--format", "json", "code", "info"], repo.path),
    ]);
    const status = statusRaw.status === "fulfilled" ? JSON.parse(statusRaw.value) : null;
    const codeInfo = codeRaw.status === "fulfilled" ? JSON.parse(codeRaw.value) : null;
    updateTicker(host, status, codeInfo);
  } catch {
    host.clearTicker("mdkb-status");
  }
}
