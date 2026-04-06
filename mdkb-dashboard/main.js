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

function statCard(value, label) {
  return `
    <div class="dash-stat">
      <div class="dash-stat-label">${label}</div>
      <div class="dash-stat-value">${value}</div>
    </div>`;
}

function renderDashboard(data, repoPath) {
  const { status, stats, memories, config, error } = data;
  const repoName = repoPath.split("/").pop();

  if (error && !status) {
    return buildPage(repoName, `
      <div class="dash-section">
        <div class="empty-state">
          <h2>mdkb not available</h2>
          <p>${esc(error)}</p>
          <p class="hint">Make sure <code>mdkb</code> is installed and the project has been initialized with <code>mdkb init</code>.</p>
        </div>
      </div>
    `);
  }

  const sections = [];

  // --- Overview section ---
  if (status) {
    const idx = status.index;
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Index Overview
          <span class="dash-section-hint">Updated ${relativeTime(idx.last_updated)}</span>
        </h2>
        <div class="dash-stat-grid">
          ${statCard(idx.documents, "Documents")}
          ${statCard(idx.stale_documents, "Stale")}
          ${statCard(idx.collections, "Collections")}
          ${statCard(formatBytes(idx.db_size_bytes), "DB Size")}
        </div>
      </div>
    `);
  }

  // --- Collections section ---
  if (status && status.collections && status.collections.length > 0) {
    const rows = status.collections.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><code>${esc(c.path)}</code></td>
        <td><code>${esc(c.pattern)}</code></td>
        <td class="num">${c.doc_count}</td>
        <td><span class="badge badge-muted">${esc(c.source)}</span></td>
      </tr>
    `).join("");

    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Collections</h2>
        <table>
          <thead><tr><th>Name</th><th>Path</th><th>Pattern</th><th class="num">Docs</th><th>Source</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Memories section ---
  if (memories && memories.length > 0) {
    const rows = memories.slice(0, 30).map((m) => {
      const badgeClass = { problem: "badge-error", decision: "badge-accent", topic: "badge-success" }[m.entry_type] || "badge-muted";
      const tags = (m.tags || []).map((t) => `<span class="badge badge-muted">${esc(t)}</span>`).join(" ");
      return `
        <tr>
          <td><code>${esc(m.id)}</code></td>
          <td>${esc(m.title)}</td>
          <td><span class="badge ${badgeClass}">${esc(m.entry_type)}</span></td>
          <td class="num">${m.access_count || 0}</td>
          <td>${tags}</td>
        </tr>
      `;
    }).join("");

    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Memories
          <span class="dash-section-hint">${memories.length} total${memories.length > 30 ? ", showing 30" : ""}</span>
        </h2>
        <table>
          <thead><tr><th>ID</th><th>Title</th><th>Type</th><th class="num">Hits</th><th>Tags</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Code Index section ---
  if (data.codeInfo) {
    const ci = data.codeInfo;
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Code Index</h2>
        <div class="dash-stat-grid">
          ${statCard(ci.files, "Files")}
          ${statCard(ci.symbols, "Symbols")}
          ${statCard(ci.relationships, "Relationships")}
        </div>
      </div>
    `);
  }

  // --- Usage stats section ---
  if (stats) {
    const agg = stats.aggregate;
    const recentSessions = (stats.sessions || []).filter((s) => s.total_calls > 0).slice(0, 5);

    const sessionsTable = recentSessions.length > 0 ? `
      <table>
        <thead><tr><th>Session</th><th>Started</th><th class="num">Calls</th><th class="num">Tokens</th><th>Tools</th></tr></thead>
        <tbody>
          ${recentSessions.map((s) => `
            <tr>
              <td>#${s.id}</td>
              <td>${relativeTime(s.started_at)}</td>
              <td class="num">${s.total_calls}</td>
              <td class="num">${s.total_tokens.toLocaleString()}</td>
              <td><code>${(s.tool_usage || []).map((t) => `${t.tool_name}:${t.call_count}`).join(", ") || "—"}</code></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : "";

    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Usage Stats</h2>
        <div class="dash-stat-grid">
          ${statCard(agg.total_sessions, "Sessions")}
          ${statCard(agg.total_calls, "Total Calls")}
          ${statCard(agg.total_tokens.toLocaleString(), "Tokens")}
          ${statCard(agg.avg_tokens_per_call.toFixed(1), "Avg Tok/Call")}
        </div>
        ${sessionsTable}
      </div>
    `);
  }

  // --- Config section ---
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

  return buildPage(repoName, sections.join("\n"));
}

function buildPage(repoName, body) {
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
</style>
</head>
<body>
<div class="dashboard">
  <div class="dash-header">
    <h1 class="dash-title">mdkb <span class="repo-name">${esc(repoName)}</span></h1>
  </div>
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
