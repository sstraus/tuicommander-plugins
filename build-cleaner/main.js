/**
 * Build Artifacts Cleaner — reclaim disk from stale build directories.
 *
 * Scans registered repos for build-artifact dirs across 15 toolchains (see
 * KIND_LABELS; the authoritative rule table is ARTIFACT_RULES in
 * src-tauri/src/plugin_fs.rs), shows per-repo sizes + last-build age in a
 * dashboard, offers a guarded one-click cleanup, and warns via the bell + status
 * ticker when reclaimable disk crosses a configurable threshold.
 *
 * Capabilities: fs:scan (read-only walk), fs:delete (guarded remove_dir_all),
 *               ui:panel (dashboard), ui:ticker (status bar warning).
 *
 * The Rust backend owns the sharp edges: scan_build_artifacts ignores gitignore
 * and stops-at-match (no double counting); delete_build_artifact re-validates
 * containment inside a registered repo before removing anything. This JS only
 * renders and orchestrates.
 */

const PLUGIN_ID = "build-cleaner";
const SECTION_ID = "build-cleaner";
const TICKER_ID = `${PLUGIN_ID}:reclaimable`;
const BELL_ID = `${PLUGIN_ID}:reclaimable`;

const GIB = 1024 * 1024 * 1024;
const HOUR_SECS = 3600;

/** Human-readable label per artifact `kind` returned by the scanner.
 *  MUST stay in sync with `ARTIFACT_RULES` in `src-tauri/src/plugin_fs.rs`. */
const KIND_LABELS = {
  rust: "Rust (target)",
  maven: "Maven (target)",
  node: "Node (node_modules)",
  jscache: "JS cache (.next / .turbo / …)",
  python: "Python (.venv / caches)",
  dotnet: ".NET (obj / bin)",
  gradle: "Gradle (build / .gradle)",
  cmake: "CMake (build)",
  swift: "Swift (.build / Pods)",
  flutter: "Flutter (build / .dart_tool)",
  terraform: "Terraform (.terraform)",
  elixir: "Elixir (_build)",
  zig: "Zig (zig-out / .zig-cache)",
  haskell: "Haskell (.stack-work / dist-newstyle)",
  php: "PHP (vendor)",
};

/** All kinds the scanner can emit — the default enabled set. */
const ALL_KINDS = Object.keys(KIND_LABELS);

/**
 * Default configuration. Overridden by persisted config (config.json) merged on
 * load. Sizes in bytes, windows in seconds so no unit ambiguity crosses IPC.
 */
const DEFAULTS = {
  perArtifactWarnBytes: 5 * GIB, // flag a single artifact this big
  totalWarnBytes: 50 * GIB, // total reclaimable → "warn"
  totalCriticalBytes: 150 * GIB, // total reclaimable → "critical"
  hotWindowSecs: 24 * HOUR_SECS, // artifacts built within this are excluded (active builds)
  // Background threshold poll cadence. Each poll is a full stat-heavy walk of
  // every repo (tens of seconds on big target/ trees), and reclaimable disk
  // changes on a scale of days — 60min keeps the nag fresh at ~1% of the I/O
  // cost of the old 5min default. Exposed in the settings form.
  pollIntervalMs: 60 * 60 * 1000,
  enabledKinds: [...ALL_KINDS],
};

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 1.22a.75.75 0 0 1 0 1.06l-2.03 2.03 1.06 1.06a.75.75 0 0 1-.16 1.2l-1.1.55-4.6 4.6a2.5 2.5 0 0 1-1.2.67l-3.2.73a.75.75 0 0 1-.9-.9l.73-3.2a2.5 2.5 0 0 1 .67-1.2l4.6-4.6.55-1.1a.75.75 0 0 1 1.2-.16l1.06 1.06 2.03-2.03a.75.75 0 0 1 1.06 0zM6.1 6.9 2.6 10.4a1 1 0 0 0-.27.48l-.5 2.2 2.2-.5a1 1 0 0 0 .48-.27L8.7 8.9 6.1 6.9z"/></svg>`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — the plugin loader only reads
// `.default`, so these named exports are inert at runtime)
// ---------------------------------------------------------------------------

/** Format a byte count as a compact binary-unit string (KiB/MiB/GiB/TiB). */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // One decimal for sub-100 values, whole for the rest; drop a trailing ".0".
  const rounded = v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Format an age (now − mtime) as a coarse human string. Returns "—" for an
 * unknown mtime (0, which the scanner emits when a dir is unreadable/empty).
 */
export function fmtAge(mtimeSecs, nowSecs) {
  if (!mtimeSecs) return "—";
  const secs = Math.max(0, nowSecs - mtimeSecs);
  if (secs < HOUR_SECS) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 24 * HOUR_SECS) return `${Math.round(secs / HOUR_SECS)}h`;
  const days = Math.round(secs / (24 * HOUR_SECS));
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

/** Basename of an absolute path (POSIX or Windows separators). */
export function basename(p) {
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Path of `child` relative to `repo` root, for compact display. */
export function relPath(child, repo) {
  if (child.startsWith(repo)) {
    const rest = child.slice(repo.length).replace(/^[/\\]+/, "");
    return rest || basename(child);
  }
  return child;
}

/**
 * Classify the current reclaimable footprint. Only artifacts that are (a) of an
 * enabled kind and (b) OLDER than the hot-window count toward the nag total —
 * a `target/` from a build 10 minutes ago is excluded so we don't pester during
 * active work. A single stale artifact ≥ perArtifactWarnBytes also trips "warn".
 *
 * `trimmableBytes` is the share of `totalBytes` that a Trim would reclaim while
 * leaving the built executables in place. It never drives a threshold — the nag
 * is about disk, not about which action you take — it is reported so the
 * dashboard can show how much of the total is safe to reclaim.
 *
 * @returns {{severity:"none"|"warn"|"critical", totalBytes:number,
 *            trimmableBytes:number, staleCount:number, largest:object|null}}
 */
export function evaluateThresholds(entries, cfg, nowSecs) {
  const kinds = new Set(cfg.enabledKinds);
  const stale = entries.filter(
    (e) => kinds.has(e.kind) && nowSecs - e.last_modified_secs >= cfg.hotWindowSecs,
  );
  const totalBytes = stale.reduce((s, e) => s + e.size_bytes, 0);
  const trimmableBytes = stale.reduce((s, e) => s + (e.trimmable_bytes || 0), 0);
  const largest = stale.reduce((m, e) => (e.size_bytes > (m ? m.size_bytes : 0) ? e : m), null);

  let severity = "none";
  if (totalBytes >= cfg.totalCriticalBytes) {
    severity = "critical";
  } else if (
    totalBytes >= cfg.totalWarnBytes ||
    (largest && largest.size_bytes >= cfg.perArtifactWarnBytes)
  ) {
    severity = "warn";
  }
  return { severity, totalBytes, trimmableBytes, staleCount: stale.length, largest };
}

/**
 * Reflect a completed clean/trim in the cached scan without re-walking the
 * filesystem. A clean removes the entry; a trim keeps it — the executables are
 * still on disk — and subtracts what the backend just reclaimed.
 */
export function applyRemoval(entries, path, trim) {
  if (!trim) return entries.filter((e) => e.path !== path);
  return entries.map((e) =>
    e.path === path
      ? { ...e, size_bytes: Math.max(0, e.size_bytes - e.trimmable_bytes), trimmable_bytes: 0 }
      : e,
  );
}

/** Ticker priority from severity — mirrors claudeUsage getTickerPriority tiers. */
export function tickerPriority(severity) {
  if (severity === "critical") return 90;
  if (severity === "warn") return 50;
  return 10;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Config as GiB/hours/minutes for the settings form. Inverse of formToConfig. */
export function configToForm(cfg) {
  return {
    perArtifactWarnGiB: +(cfg.perArtifactWarnBytes / GIB).toFixed(1),
    totalWarnGiB: +(cfg.totalWarnBytes / GIB).toFixed(1),
    totalCriticalGiB: +(cfg.totalCriticalBytes / GIB).toFixed(1),
    hotWindowHours: +(cfg.hotWindowSecs / HOUR_SECS).toFixed(1),
    pollIntervalMinutes: Math.round(cfg.pollIntervalMs / 60000),
    enabledKinds: [...cfg.enabledKinds],
  };
}

/** Build a validated config from raw settings-form values, clamped to sane bounds. */
export function formToConfig(form, base) {
  const pos = (v, fallback) => (Number.isFinite(+v) && +v > 0 ? +v : fallback);
  const kinds = Array.isArray(form.enabledKinds)
    ? form.enabledKinds.filter((k) => ALL_KINDS.includes(k))
    : base.enabledKinds;
  return {
    ...base,
    perArtifactWarnBytes: pos(form.perArtifactWarnGiB, base.perArtifactWarnBytes / GIB) * GIB,
    totalWarnBytes: pos(form.totalWarnGiB, base.totalWarnBytes / GIB) * GIB,
    totalCriticalBytes: pos(form.totalCriticalGiB, base.totalCriticalBytes / GIB) * GIB,
    hotWindowSecs: pos(form.hotWindowHours, base.hotWindowSecs / HOUR_SECS) * HOUR_SECS,
    // Floor of 5 minutes — each poll is a full repo walk; anything faster is
    // pure I/O waste and was the cause of the old ~10% duty cycle.
    pollIntervalMs: Math.max(5, pos(form.pollIntervalMinutes, base.pollIntervalMs / 60000)) * 60000,
    enabledKinds: kinds.length ? kinds : [...ALL_KINDS],
  };
}

/**
 * Render the full dashboard HTML. Pure: given the same scan + config it returns
 * identical markup, so it can be unit-tested and diffed. Groups artifacts by
 * repo (largest repo first), totals in `.dash-stat` cards, one table per repo.
 *
 * `entries === null` means "no scan yet" — renders a scanning placeholder so
 * the panel can open instantly while the (slow) walk runs. `opts.scanning`
 * disables the Rescan button and relabels it while a scan is in flight.
 */
export function buildPanelHtml(entries, cfg, nowSecs, opts = {}) {
  const scanning = opts.scanning === true || entries === null;
  const kinds = new Set(cfg.enabledKinds);
  const visible = (entries || []).filter((e) => kinds.has(e.kind));
  const evalRes = evaluateThresholds(entries || [], cfg, nowSecs);
  const form = configToForm(cfg);

  const body =
    entries === null
      ? `<div class="empty-state">Scanning repositories…</div>`
      : visible.length === 0
        ? emptyState()
        : buildRepoSections(visible, cfg, nowSecs);
  const stats = entries === null ? "" : buildStatCards(visible, evalRes, cfg);
  const settings = buildSettingsSection(form);

  return `<!DOCTYPE html>
<html>
<head>
<style>
  /* Plugin-specific tweaks only — layout/cards/tables come from PLUGIN_BASE_CSS. */
  .repo-total { color: var(--fg-secondary); font-weight: 500; }
  .badge-hot { color: var(--warning); border-color: var(--warning); }
  /* Fixed layout + shared colgroup widths so columns line up ACROSS the
     per-repo tables (auto layout sizes each table independently). */
  table { table-layout: fixed; }
  col.c-kind { width: 200px; }
  col.c-size { width: 80px; }
  col.c-age { width: 60px; }
  col.c-action { width: 150px; }
  td, th { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td:first-child { white-space: normal; overflow-wrap: anywhere; }
  td.actions { text-align: right; white-space: nowrap; }
  /* Two risk tiers, colour-coded: .safe keeps the built executables, .danger
     removes them too. Both arm before firing — a trim still costs a rebuild. */
  button.safe, button.danger {
    background: transparent;
    border: 1px solid var(--border); border-radius: 4px;
    padding: 2px 10px; font-size: 11px; cursor: pointer;
  }
  button.safe { color: var(--fg-primary); }
  button.danger { color: var(--error); }
  button.safe:hover, button.safe.armed { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  button.danger:hover, button.danger.armed { background: var(--error); color: var(--bg-primary); border-color: var(--error); }
  button.safe:disabled, button.danger:disabled { opacity: 0.5; cursor: default; background: transparent; color: var(--fg-muted); }
  details.settings { margin-top: 4px; }
  details.settings summary { cursor: pointer; color: var(--fg-secondary); font-size: 12px; }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-top: 10px; }
  .settings-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-secondary); }
  .settings-grid input[type="number"] {
    background: var(--bg-tertiary); color: var(--fg-primary);
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; font-size: 12px;
  }
  .kinds { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .kinds label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-secondary); }
</style>
</head>
<body>
<div class="dashboard">
  <div class="dash-header">
    <h1 class="dash-title">Build Artifacts Cleaner</h1>
    <button id="btn-refresh" class="primary"${scanning ? " disabled" : ""}>${scanning ? "Scanning…" : "Rescan"}</button>
  </div>
  ${stats}
  ${body}
  ${settings}
</div>
<script>
  const post = (m) => window.parent.postMessage(m, "*");

  document.getElementById("btn-refresh").addEventListener("click", () => post({ action: "refresh" }));

  // Two-step arm/confirm instead of a native confirm() dialog: the panel
  // iframe sandbox has no allow-modals, so a modal would silently return
  // false and the delete would never fire. First click arms the button,
  // second click (within 4s) fires; the arm auto-reverts otherwise.
  // Trim arms too — it spares the executables but still costs a full rebuild.
  const LABELS = {
    trim: { idle: "Trim", armed: "Trim?", busy: "Trimming…" },
    delete: { idle: "Clean", armed: "Delete all?", busy: "Deleting…" },
  };
  document.querySelectorAll("button[data-action]").forEach((btn) => {
    const labels = LABELS[btn.dataset.action];
    let disarmTimer = null;
    btn.addEventListener("click", () => {
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.classList.add("armed");
        btn.textContent = labels.armed;
        disarmTimer = setTimeout(() => {
          btn.dataset.armed = "";
          btn.classList.remove("armed");
          btn.textContent = labels.idle;
        }, 4000);
        return;
      }
      clearTimeout(disarmTimer);
      const path = btn.dataset.path;
      // Disable BOTH actions for this row — the other one operates on a tree
      // that is about to change under it.
      document.querySelectorAll('button[data-path="' + CSS.escape(path) + '"]').forEach((b) => {
        b.disabled = true;
        if (b === btn) b.textContent = labels.busy;
      });
      post({ action: btn.dataset.action, path });
    });
  });

  const saveBtn = document.getElementById("btn-save-config");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const num = (id) => parseFloat(document.getElementById(id).value);
      const enabledKinds = Array.from(document.querySelectorAll(".kinds input:checked")).map((i) => i.value);
      post({
        action: "saveConfig",
        config: {
          perArtifactWarnGiB: num("cfg-perArtifact"),
          totalWarnGiB: num("cfg-totalWarn"),
          totalCriticalGiB: num("cfg-totalCritical"),
          hotWindowHours: num("cfg-hotWindow"),
          pollIntervalMinutes: num("cfg-pollInterval"),
          enabledKinds,
        },
      });
    });
  }
</script>
</body>
</html>`;
}

function emptyState() {
  return `<div class="empty-state">No build artifacts found in your registered repos. Nothing to reclaim.</div>`;
}

function buildStatCards(visible, evalRes, cfg) {
  const totalAll = visible.reduce((s, e) => s + e.size_bytes, 0);
  const repos = new Set(visible.map((e) => e.repo)).size;
  const meterPct = cfg.totalWarnBytes > 0 ? Math.min(100, (evalRes.totalBytes / cfg.totalWarnBytes) * 100) : 0;
  const meterClass = evalRes.severity === "critical" ? "critical" : evalRes.severity === "warn" ? "warn" : "ok";
  const meter = `<div class="dash-meter"><div class="dash-meter-fill ${meterClass}" style="width:${meterPct.toFixed(0)}%"></div></div>`;

  const card = (label, value, extra = "") =>
    `<div class="dash-stat"><div class="dash-stat-label">${label}</div><div class="dash-stat-value">${value}</div>${extra}</div>`;

  return `<div class="dash-section">
    <h2 class="dash-section-title">Overview <span class="dash-section-hint">reclaimable excludes the last ${Math.round(cfg.hotWindowSecs / HOUR_SECS)}h · trim keeps the built executables</span></h2>
    <div class="dash-stat-grid">
      ${card("Reclaimable", fmtBytes(evalRes.totalBytes), meter)}
      ${card("Safe to trim", fmtBytes(evalRes.trimmableBytes))}
      ${card("Total on disk", fmtBytes(totalAll))}
      ${card("Artifacts", String(visible.length))}
      ${card("Repos", String(repos))}
    </div>
  </div>`;
}

function buildRepoSections(visible, cfg, nowSecs) {
  const byRepo = new Map();
  for (const e of visible) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo).push(e);
  }

  const repoTotals = [...byRepo.entries()]
    .map(([repo, arts]) => ({ repo, arts, total: arts.reduce((s, e) => s + e.size_bytes, 0) }))
    .sort((a, b) => b.total - a.total);

  return repoTotals
    .map(({ repo, arts, total }) => {
      const rows = arts
        .slice()
        .sort((a, b) => b.size_bytes - a.size_bytes)
        .map((e) => {
          const hot = nowSecs - e.last_modified_secs < cfg.hotWindowSecs;
          const hotBadge = hot ? ` <span class="badge badge-hot">recent</span>` : "";
          const kindLabel = KIND_LABELS[e.kind] || e.kind;
          const path = escapeHtml(e.path);
          // Trim is offered only when the backend found separable intermediates
          // for this toolchain — node_modules/.venv report 0 and get Clean only.
          const trimBtn = e.trimmable_bytes
            ? `<button class="safe" data-action="trim" data-path="${path}">Trim</button> `
            : "";
          return `<tr>
            <td><code>${escapeHtml(relPath(e.path, repo))}</code>${hotBadge}</td>
            <td>${escapeHtml(kindLabel)}</td>
            <td class="num">${fmtBytes(e.size_bytes)}</td>
            <td class="num">${e.trimmable_bytes ? fmtBytes(e.trimmable_bytes) : "—"}</td>
            <td class="num">${fmtAge(e.last_modified_secs, nowSecs)}</td>
            <td class="actions">${trimBtn}<button class="danger" data-action="delete" data-path="${path}">Clean</button></td>
          </tr>`;
        })
        .join("");

      return `<div class="dash-section">
        <h2 class="dash-section-title">${escapeHtml(basename(repo))} <span class="repo-total">${fmtBytes(total)}</span></h2>
        <table>
          <colgroup><col/><col class="c-kind"/><col class="c-size"/><col class="c-size"/><col class="c-age"/><col class="c-action"/></colgroup>
          <thead><tr><th>Path</th><th>Kind</th><th class="num">Size</th><th class="num">Trimmable</th><th class="num">Age</th><th class="num">Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("");
}

function buildSettingsSection(form) {
  const kindCheckbox = (kind) =>
    `<label><input type="checkbox" value="${kind}" ${form.enabledKinds.includes(kind) ? "checked" : ""}/> ${escapeHtml(KIND_LABELS[kind] || kind)}</label>`;

  const numInput = (id, label, value) =>
    `<label>${label}<input type="number" id="${id}" min="0" step="0.5" value="${value}"/></label>`;

  return `<details class="settings">
    <summary>Settings &amp; thresholds</summary>
    <div class="dash-section">
      <div class="settings-grid">
        ${numInput("cfg-perArtifact", "Per-artifact warn (GiB)", form.perArtifactWarnGiB)}
        ${numInput("cfg-hotWindow", "Hot-window exclude (hours)", form.hotWindowHours)}
        ${numInput("cfg-totalWarn", "Total warn (GiB)", form.totalWarnGiB)}
        ${numInput("cfg-totalCritical", "Total critical (GiB)", form.totalCriticalGiB)}
        ${numInput("cfg-pollInterval", "Background scan every (minutes)", form.pollIntervalMinutes)}
      </div>
      <div class="kinds">${ALL_KINDS.map(kindCheckbox).join("")}</div>
      <div style="margin-top:12px"><button id="btn-save-config" class="primary">Save settings</button></div>
    </div>
  </details>`;
}

// ---------------------------------------------------------------------------
// Runtime state + lifecycle
// ---------------------------------------------------------------------------

let hostRef = null;
let panelHandle = null;
let pollTimer = null;
let lifecycleGeneration = 0;
let config = { ...DEFAULTS };
/** Last completed scan result (null until the first scan finishes). Lets the
 *  dashboard open instantly with recent data instead of blocking on a walk
 *  that can take tens of seconds on large target/ trees. */
let lastEntries = null;

/** Wall-clock seconds. Isolated so tests can inject a fixed clock. */
function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

function isCurrentLifecycle(host, generation) {
  return hostRef === host && lifecycleGeneration === generation;
}

function repoPaths(host = hostRef) {
  if (!host) return [];
  return host
    .getRepos()
    .map((r) => r.path)
    .filter(Boolean);
}

async function scan(forceRefresh = false, host = hostRef, generation = lifecycleGeneration) {
  if (!host) return null;
  const paths = repoPaths(host);
  if (paths.length === 0) {
    if (!isCurrentLifecycle(host, generation)) return null;
    lastEntries = [];
    return lastEntries;
  }
  try {
    const entries = await host.scanBuildArtifacts(paths, { forceRefresh });
    if (!isCurrentLifecycle(host, generation)) return null;
    lastEntries = entries;
  } catch (err) {
    if (!isCurrentLifecycle(host, generation)) return null;
    host.log("warn", `scan failed: ${err}`);
    lastEntries = lastEntries || [];
  }
  return lastEntries;
}

function renderPanel(entries) {
  const html = buildPanelHtml(entries, config, nowSecs());
  if (panelHandle) {
    panelHandle.update(html);
  }
  return html;
}

async function openDashboard() {
  const host = hostRef;
  const generation = lifecycleGeneration;
  if (!host) return;
  // Open instantly with the last scan (or a scanning placeholder), then
  // refresh in the background — the walk can take tens of seconds.
  panelHandle = host.openPanel({
    id: PLUGIN_ID,
    title: "Build Cleaner",
    html: buildPanelHtml(lastEntries, config, nowSecs(), { scanning: true }),
    onMessage: handlePanelMessage,
  });
  const entries = await scan(false, host, generation);
  if (entries !== null && isCurrentLifecycle(host, generation)) renderPanel(entries);
}

async function handlePanelMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.action === "refresh") {
    const host = hostRef;
    const generation = lifecycleGeneration;
    if (!host) return;
    if (panelHandle) {
      panelHandle.update(buildPanelHtml(lastEntries, config, nowSecs(), { scanning: true }));
    }
    const entries = await scan(true, host, generation);
    if (entries !== null && isCurrentLifecycle(host, generation)) renderPanel(entries);
    return;
  }

  if ((msg.action === "delete" || msg.action === "trim") && typeof msg.path === "string") {
    const host = hostRef;
    const generation = lifecycleGeneration;
    if (!host) return;
    const trim = msg.action === "trim";
    try {
      await (trim
        ? host.trimBuildArtifact(msg.path, repoPaths(host))
        : host.deleteBuildArtifact(msg.path, repoPaths(host)));
      if (!isCurrentLifecycle(host, generation)) return;
      host.log("info", `${trim ? "trimmed" : "deleted"} ${msg.path}`);
      // Patch the cache instead of a full rescan (tens of seconds on large
      // trees) — the background poll reconciles any drift.
      lastEntries = applyRemoval(lastEntries || [], msg.path, trim);
    } catch (err) {
      if (!isCurrentLifecycle(host, generation)) return;
      host.log("error", `${trim ? "trim" : "delete"} failed for ${msg.path}: ${err}`);
    }
    renderPanel(lastEntries || []);
    updateThresholdState(lastEntries || []);
    return;
  }

  if (msg.action === "saveConfig" && msg.config) {
    const host = hostRef;
    const generation = lifecycleGeneration;
    if (!host) return;
    config = formToConfig(msg.config, config);
    await saveConfig(host, generation);
    if (!isCurrentLifecycle(host, generation)) return;
    startPollTimer(); // cadence may have changed
    // No rescan needed — kind filtering and thresholds are applied at render.
    renderPanel(lastEntries || []);
    updateThresholdState(lastEntries || []);
  }
}

// ---------------------------------------------------------------------------
// Threshold monitor (bell + ticker)
// ---------------------------------------------------------------------------

/** Ensure the Activity Center section exists, then apply/clear the bell + ticker. */
function updateThresholdState(entries, host = hostRef) {
  if (!host) return;
  const res = evaluateThresholds(entries, config, nowSecs());

  if (res.severity === "none") {
    host.removeItem(BELL_ID);
    host.clearTicker(TICKER_ID);
    return;
  }

  const sizeStr = fmtBytes(res.totalBytes);
  const largestStr = res.largest ? `${fmtBytes(res.largest.size_bytes)} in ${basename(res.largest.repo)}` : "";

  host.addItem({
    id: BELL_ID,
    pluginId: PLUGIN_ID,
    sectionId: SECTION_ID,
    title: `${sizeStr} of build artifacts reclaimable`,
    subtitle: largestStr ? `Largest: ${largestStr}` : `${res.staleCount} stale directories`,
    icon: ICON,
    severity: res.severity === "critical" ? "error" : "warn",
    dismissible: true,
    onClick: () => openDashboard(),
  });

  host.setTicker({
    id: TICKER_ID,
    label: "Build",
    text: `${sizeStr} reclaimable`,
    icon: ICON,
    priority: tickerPriority(res.severity),
    onClick: () => openDashboard(),
  });
}

async function poll() {
  const host = hostRef;
  const generation = lifecycleGeneration;
  if (!host) return;
  const entries = await scan(false, host, generation);
  if (entries === null || !isCurrentLifecycle(host, generation)) return;
  updateThresholdState(entries, host);
}

/** (Re)start the background poll with the current config's cadence. */
function startPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, config.pollIntervalMs);
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig(host, generation) {
  try {
    const raw = await host.invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: "config.json" });
    if (!isCurrentLifecycle(host, generation)) return false;
    if (raw) {
      const parsed = JSON.parse(raw);
      config = { ...DEFAULTS, ...parsed };
      // enabledKinds must stay a valid subset even if the stored file is stale.
      if (!Array.isArray(config.enabledKinds) || config.enabledKinds.length === 0) {
        config.enabledKinds = [...ALL_KINDS];
      } else {
        config.enabledKinds = config.enabledKinds.filter((k) => ALL_KINDS.includes(k));
        if (config.enabledKinds.length === 0) config.enabledKinds = [...ALL_KINDS];
      }
    }
  } catch {
    if (!isCurrentLifecycle(host, generation)) return false;
    config = { ...DEFAULTS };
  }
  return true;
}

async function saveConfig(host, generation) {
  try {
    await host.invoke("write_plugin_data", {
      pluginId: PLUGIN_ID,
      path: "config.json",
      content: JSON.stringify(config),
    });
  } catch (err) {
    if (isCurrentLifecycle(host, generation)) host.log("warn", `config persist failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,

  async onload(host) {
    const generation = ++lifecycleGeneration;
    hostRef = host;

    host.registerSection({
      id: SECTION_ID,
      label: "BUILD CLEANER",
      priority: 55,
      canDismissAll: true,
    });

    host.registerDashboard({
      label: "Build Cleaner",
      icon: ICON,
      open: () => openDashboard(),
    });

    if (!(await loadConfig(host, generation))) return;

    // Initial scan + threshold check, then poll on the configured cadence.
    poll();
    startPollTimer();
  },

  onunload() {
    lifecycleGeneration += 1;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    hostRef?.clearTicker(TICKER_ID);
    hostRef?.removeItem(BELL_ID);
    panelHandle = null;
    hostRef = null;
  },
};
