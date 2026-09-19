const PLUGIN_ID = "plan";

let hostRef = null;
let watchDisposable = null;
let watchGeneration = 0;
const knownPlans = new Set();

function isAbsolutePath(path) {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinPath(root, relative) {
  if (!root) return relative;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.replace(/^[\\/]+/, "")}`;
}

function isMissing(error) {
  const message = String(error);
  return message.includes("not found") || message.includes("No such file");
}

function stopWatch() {
  watchGeneration += 1;
  watchDisposable?.dispose();
  watchDisposable = null;
}

async function listPlans(repoPath, openNew) {
  if (!hostRef) return;
  const plansDir = joinPath(repoPath, "plans");
  try {
    const names = await hostRef.listDirectory(plansDir, "*.md");
    for (const name of names) {
      const absolutePath = joinPath(plansDir, name);
      const isNew = !knownPlans.has(absolutePath);
      knownPlans.add(absolutePath);
      if (openNew && isNew) hostRef.openMarkdownFileBackground(absolutePath);
    }
  } catch (error) {
    if (!isMissing(error)) hostRef.log("warn", "Failed to scan plans directory", String(error));
  }
}

async function openActivePlan(repoPath) {
  if (!hostRef) return;
  const markers = [joinPath(repoPath, ".claude/active-plan.json"), joinPath(repoPath, "src-tauri/.claude/active-plan.json")];
  for (const marker of markers) {
    try {
      const parsed = JSON.parse(await hostRef.readFile(marker));
      if (!parsed || typeof parsed.path !== "string") continue;
      const absolutePath = isAbsolutePath(parsed.path) ? parsed.path : joinPath(repoPath, parsed.path);
      // Open once per path, like the other two entry points. This runs on every
      // repo switch, so opening unconditionally re-created a tab the user had
      // closed every time they came back to the repo.
      if (!knownPlans.has(absolutePath)) {
        knownPlans.add(absolutePath);
        hostRef.openMarkdownFileBackground(absolutePath);
      }
      return;
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) {
        hostRef.log("warn", `Failed to read active-plan marker ${marker}`, String(error));
      }
    }
  }
}

async function watchPlans(repoPath) {
  const generation = ++watchGeneration;
  const plansDir = joinPath(repoPath, "plans");
  try {
    const disposable = await hostRef.watchPath(plansDir, () => void listPlans(repoPath, true));
    if (!hostRef || generation !== watchGeneration) disposable.dispose();
    else watchDisposable = disposable;
  } catch (error) {
    if (!isMissing(error)) hostRef?.log("warn", "Failed to watch plans directory", String(error));
  }
}

function activateRepo(repoPath) {
  stopWatch();
  if (!repoPath) return;
  void listPlans(repoPath, false);
  void openActivePlan(repoPath);
  void watchPlans(repoPath);
}

export default {
  id: PLUGIN_ID,
  onload(host) {
    hostRef = host;
    knownPlans.clear();

    host.registerStructuredEventHandler("plan-file", (payload, sessionId) => {
      if (!payload || typeof payload !== "object" || typeof payload.path !== "string") return;
      const cwd = host.getSessionCwd(sessionId);
      const absolutePath = isAbsolutePath(payload.path) ? payload.path : cwd ? joinPath(cwd, payload.path) : payload.path;
      if (!isAbsolutePath(absolutePath) || knownPlans.has(absolutePath)) return;
      knownPlans.add(absolutePath);
      host.openMarkdownFileBackground(absolutePath);
    });

    host.onStateChange((event) => {
      if (event.type === "repo-changed") activateRepo(host.getActiveRepoPath());
    });

    activateRepo(host.getActiveRepoPath());
  },
  onunload() {
    stopWatch();
    knownPlans.clear();
    hostRef = null;
  },
};
