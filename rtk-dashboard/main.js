/**
 * RTK Dashboard Plugin — Token savings visualization
 *
 * Shows RTK token savings stats, missed optimization opportunities,
 * and daily trends in an interactive HTML panel.
 *
 * Capabilities: exec:cli, ui:panel, ui:context-menu
 * Binaries: rtk
 */

const PLUGIN_ID = "rtk-dashboard";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 14h13a.5.5 0 0 0 0-1H2V1.5a.5.5 0 0 0-1 0v12a.5.5 0 0 0 .5.5z"/><path d="M3.5 11.5a.5.5 0 0 1-.354-.854l3-3a.5.5 0 0 1 .708 0L9 9.793l3.646-3.647a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0L6.5 8.707l-2.646 2.647a.5.5 0 0 1-.354.146z"/></svg>`;

let hostRef = null;
let panelHandle = null;

// ── Data fetching ─────────────────────────────────────────────────────────

async function fetchRtk(args) {
  try {
    return await hostRef.execCli("rtk", args);
  } catch (err) {
    hostRef.log("warn", `rtk ${args.join(" ")} failed`, String(err));
    return null;
  }
}

async function fetchAllData() {
  const [gainRaw, dailyRaw, discoverRaw] = await Promise.all([
    fetchRtk(["gain", "--format", "json"]),
    fetchRtk(["gain", "--daily", "--format", "json"]),
    fetchRtk(["discover", "--format", "json", "--limit", "15"]),
  ]);

  return {
    gain: gainRaw ? JSON.parse(gainRaw) : null,
    daily: dailyRaw ? JSON.parse(dailyRaw) : null,
    discover: discoverRaw ? JSON.parse(discoverRaw) : null,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtPct(n) {
  return n.toFixed(1) + "%";
}

function fmtMs(ms) {
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + "m";
  if (ms >= 1_000) return (ms / 1_000).toFixed(1) + "s";
  return ms + "ms";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Panel HTML ────────────────────────────────────────────────────────────

function buildPanelHtml(data) {
  const summaryHtml = buildSummarySection(data.gain);
  const dailyHtml = buildDailySection(data.daily);
  const discoverHtml = buildDiscoverSection(data.discover);

  return `<!DOCTYPE html>
<html>
<head>
<style>
  /* Plugin-specific overrides only. Layout/cards/typography come from
     PLUGIN_BASE_CSS (.dashboard, .dash-*). See docs/plugins-style.md. */
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 6px 14px;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--fg-secondary);
    font-size: 12px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: var(--fg-primary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .bar-cell { width: 100px; }
  .bar-bg { height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
  .bar-fg { height: 100%; background: var(--accent); border-radius: 3px; }
</style>
</head>
<body>
<div class="dashboard">
  <div class="dash-header">
    <h1 class="dash-title">RTK Token Savings</h1>
    <button id="btn-refresh" class="primary">Refresh</button>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="summary">Savings</button>
    <button class="tab" data-tab="daily">Daily</button>
    <button class="tab" data-tab="discover">Discover</button>
  </div>

  <div id="tab-summary" class="tab-content active">${summaryHtml}</div>
  <div id="tab-daily" class="tab-content">${dailyHtml}</div>
  <div id="tab-discover" class="tab-content">${discoverHtml}</div>
</div>

<script>
  const $$ = (sel) => document.querySelectorAll(sel);

  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", () => {
    window.parent.postMessage({ type: "rtk-refresh" }, "*");
  });
</script>
</body>
</html>`;
}

function meterClass(pct) {
  if (pct >= 60) return "ok";
  if (pct >= 30) return "warn";
  return "critical";
}

function statCard(value, label, extra = "") {
  return `
    <div class="dash-stat">
      <div class="dash-stat-label">${label}</div>
      <div class="dash-stat-value">${value}</div>
      ${extra}
    </div>`;
}

function buildSummarySection(gain) {
  if (!gain || !gain.summary) {
    return `<div class="empty-state">No RTK data available. Run some commands through <code>rtk</code> first.</div>`;
  }

  const s = gain.summary;
  const meter = `
    <div class="dash-meter">
      <div class="dash-meter-fill ${meterClass(s.avg_savings_pct)}" style="width:${Math.min(s.avg_savings_pct, 100)}%"></div>
    </div>`;

  return `
    <div class="dash-section">
      <h2 class="dash-section-title">Savings Overview</h2>
      <div class="dash-stat-grid">
        ${statCard(s.total_commands, "Commands")}
        ${statCard(fmtTokens(s.total_saved), "Tokens Saved")}
        ${statCard(fmtPct(s.avg_savings_pct), "Avg Savings", meter)}
        ${statCard(fmtMs(s.total_time_ms), "Total Exec Time")}
      </div>
    </div>
    <div class="dash-section">
      <h2 class="dash-section-title">Token Flow</h2>
      <div class="dash-stat-grid">
        ${statCard(fmtTokens(s.total_input), "Input Tokens")}
        ${statCard(fmtTokens(s.total_output), "Output Tokens")}
        ${statCard(fmtMs(s.avg_time_ms), "Avg Exec Time")}
      </div>
    </div>`;
}

function buildDailySection(daily) {
  if (!daily || !daily.daily || daily.daily.length === 0) {
    return `<div class="empty-state">No daily data available.</div>`;
  }

  const maxSaved = Math.max(...daily.daily.map(d => d.saved_tokens), 1);

  const rows = daily.daily.map(d => `
    <tr>
      <td>${escapeHtml(d.date)}</td>
      <td class="num">${d.commands}</td>
      <td class="num">${fmtTokens(d.saved_tokens)}</td>
      <td class="num">${fmtPct(d.savings_pct)}</td>
      <td class="bar-cell">
        <div class="bar-bg"><div class="bar-fg" style="width:${(d.saved_tokens / maxSaved * 100).toFixed(0)}%"></div></div>
      </td>
      <td class="num">${fmtMs(d.avg_time_ms)}</td>
    </tr>`).join("");

  return `
    <div class="dash-section">
      <h2 class="dash-section-title">Daily Breakdown</h2>
      <table>
        <thead>
          <tr><th>Date</th><th class="num">Cmds</th><th class="num">Saved</th><th class="num">%</th><th>Volume</th><th class="num">Avg Time</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildDiscoverSection(discover) {
  if (!discover || !discover.supported || discover.supported.length === 0) {
    return `<div class="empty-state">No missed opportunities found. You're fully optimized!</div>`;
  }

  const maxTokens = Math.max(...discover.supported.map(d => d.estimated_savings_tokens), 1);

  const rows = discover.supported.map(d => `
    <tr>
      <td><code>${escapeHtml(d.command)}</code></td>
      <td class="num">${d.count}</td>
      <td><code>${escapeHtml(d.rtk_equivalent)}</code></td>
      <td class="num">${fmtTokens(d.estimated_savings_tokens)}</td>
      <td class="bar-cell">
        <div class="bar-bg"><div class="bar-fg" style="width:${(d.estimated_savings_tokens / maxTokens * 100).toFixed(0)}%"></div></div>
      </td>
      <td class="num">${fmtPct(d.estimated_savings_pct)}</td>
    </tr>`).join("");

  const totalSaveable = discover.supported.reduce((sum, d) => sum + d.estimated_savings_tokens, 0);

  return `
    <div class="dash-section">
      <h2 class="dash-section-title">Scan Results</h2>
      <div class="dash-stat-grid">
        ${statCard(discover.sessions_scanned, "Sessions Scanned")}
        ${statCard(discover.total_commands.toLocaleString(), "Total Commands")}
        ${statCard(fmtTokens(totalSaveable), "Est. Saveable")}
      </div>
    </div>
    <div class="dash-section">
      <h2 class="dash-section-title">Missed Opportunities</h2>
      <table>
        <thead>
          <tr><th>Command</th><th class="num">Count</th><th>RTK Equivalent</th><th class="num">Est. Savings</th><th>Impact</th><th class="num">%</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Plugin exports ────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,

  async onload(host) {
    hostRef = host;

    host.registerContextMenuAction({
      id: "open-rtk-dashboard",
      label: "RTK Token Savings",
      icon: ICON,
      target: "terminal",
      action: () => openDashboard(),
    });

    host.registerDashboard({
      label: "RTK Savings",
      icon: ICON,
      open: () => openDashboard(),
    });
  },

  onunload() {
    panelHandle = null;
    hostRef = null;
  },
};

async function openDashboard() {
  const data = await fetchAllData();
  panelHandle = hostRef.openPanel({
    id: "rtk-dashboard",
    title: "RTK Token Savings",
    html: buildPanelHtml(data),
    onMessage: handlePanelMessage,
  });
}

async function handlePanelMessage(msg) {
  if (!msg || msg.type !== "rtk-refresh") return;
  const data = await fetchAllData();
  panelHandle.update(buildPanelHtml(data));
}
