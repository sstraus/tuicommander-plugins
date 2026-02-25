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
  const results = { status: null, stats: null, memories: null, config: null, error: null };

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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #c9d1d9;
    background: #0d1117;
  }
  .dashboard {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px 20px 40px;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    color: #e6edf3;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h1 .repo-name { color: #58a6ff; }
  h2 {
    font-size: 14px;
    font-weight: 600;
    color: #e6edf3;
    margin-bottom: 12px;
  }
  h2 .count { font-weight: 400; color: #8b949e; }
  h3 {
    font-size: 12px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .error-card {
    border-color: #f85149;
    background: #1c1014;
  }
  .error-card h2 { color: #f85149; }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 8px;
  }
  .stat {
    text-align: center;
    padding: 8px;
    background: #0d1117;
    border-radius: 4px;
    border: 1px solid #21262d;
  }
  .stat-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: #58a6ff;
  }
  .stat-label {
    display: block;
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  table.compact { font-size: 11px; }
  th {
    text-align: left;
    font-weight: 600;
    color: #8b949e;
    padding: 6px 8px;
    border-bottom: 1px solid #30363d;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  td {
    padding: 5px 8px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }
  .right { text-align: right; }
  .mono { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; }
  .muted { color: #8b949e; }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .badge-manual { background: #1f2937; color: #9ca3af; }
  .badge-convention { background: #1e3a2f; color: #3fb950; }
  .badge-library { background: #1e293b; color: #58a6ff; }
  .badge-sessions { background: #2d1f3d; color: #bc8cff; }
  .badge-type-red { background: #3d1418; color: #f85149; }
  .badge-type-blue { background: #121d2f; color: #58a6ff; }
  .badge-type-green { background: #122117; color: #3fb950; }
  .badge-type-gray { background: #1f2937; color: #9ca3af; }
  .tag {
    display: inline-block;
    font-size: 10px;
    padding: 0 4px;
    background: #21262d;
    color: #8b949e;
    border-radius: 3px;
    margin-right: 3px;
    margin-bottom: 2px;
  }
  .tags-cell { max-width: 200px; }
  .last-updated {
    font-size: 11px;
    color: #8b949e;
    margin-top: 8px;
  }
  .hint {
    font-size: 11px;
    color: #8b949e;
    margin-top: 8px;
    font-style: italic;
  }
  pre.config-block {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 4px;
    padding: 12px;
    font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 11px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: #c9d1d9;
  }
  .icon-inline {
    width: 16px;
    height: 16px;
    vertical-align: middle;
    fill: #58a6ff;
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

function updateTicker(host, status) {
  if (!status || !status.index) {
    host.clearTicker("mdkb-status");
    return;
  }
  const idx = status.index;
  const staleTag = idx.stale_documents > 0 ? ` (${idx.stale_documents} stale)` : "";
  host.setTicker({
    id: "mdkb-status",
    text: `${idx.documents} docs · ${idx.collections} collections${staleTag}`,
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
    updateTicker(host, data.status);
  }
}

async function refreshTicker(host) {
  const repo = host.getActiveRepo();
  if (!repo) {
    host.clearTicker("mdkb-status");
    return;
  }

  try {
    const raw = await host.execCli("mdkb", ["--format", "json", "status"], repo.path);
    const status = JSON.parse(raw);
    updateTicker(host, status);
  } catch {
    host.clearTicker("mdkb-status");
  }
}
