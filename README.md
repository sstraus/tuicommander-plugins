# TUI Commander Plugins

Community plugin registry and distributable plugins for [TUICommander](https://github.com/sstraus/tuicommander).

## Plugins

| Plugin | Description | Capabilities |
|--------|-------------|-------------|
| [at-capacity-retry](at-capacity-retry/) | Retries a Codex turn that hit "Selected model is at capacity", with a 3-per-hour circuit breaker | `pty:write`, `pty:read`, `ui:ticker`, `ui:markdown`, `ui:sound` |
| [cache-keepalive](cache-keepalive/) | Prevents Claude API prompt cache expiry during idle periods | `pty:write`, `ui:ticker` |
| [docx-preview](docx-preview/) | Preview Word `.docx`/`.dotx` files as clean HTML with Mammoth.js | `ui:file-preview`, `ui:panel`, `fs:read` |
| [mdkb-dashboard](mdkb-dashboard/) | mdkb knowledge base status, memories, config | `exec:cli`, `fs:read`, `ui:panel`, `ui:ticker` |
| [plan](plan/) | Tracks agent plan files and opens active plans in background tabs | `fs:read`, `fs:list`, `fs:watch`, `ui:markdown` |
| [sqlite-viewer](sqlite-viewer/) | Inspect, filter, explain, and safely edit SQLite databases in self-contained WebAssembly | `ui:file-preview`, `ui:panel`, `fs:read`, `fs:write` |
| [stories-ticker](stories-ticker/) | Shows the active repository's open story count | `fs:list`, `fs:watch`, `ui:ticker` |
| [tuic-vscode-icons](tuic-vscode-icons/) | 1500+ file and folder icons from vscode-icons | `ui:file-icons` |
| [wiz-kanban](wiz-kanban/) | Wiz framework workflow kanban for plans, stories, and reviews | `fs:read`, `fs:write`, `ui:panel`, `pty:write` |
| [xlsx-preview](xlsx-preview/) | Preview Excel `.xlsx`/`.xlsm`/`.xlsb`/`.xls` and OpenDocument `.ods` spreadsheets as sortable tables with SheetJS | `ui:file-preview`, `ui:panel`, `fs:read` |

The former Voice plugin has been retired. Native voice conversation is planned
in TUICommander’s Dictation settings; it is not available from this registry.

## registry.json

The app fetches `registry.json` from this repo to populate the **Browse** tab in Settings > Plugins.

### Entry format

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What it does",
  "author": "your-github-username",
  "repo": "owner/repo",
  "latestVersion": "1.0.0",
  "minAppVersion": "0.3.0",
  "capabilities": [],
  "downloadUrl": "https://github.com/owner/repo/releases/latest/download/my-plugin.zip"
}
```

## Submitting a plugin

Open a PR adding your entry to `registry.json`. Requirements:

1. Plugin has a public repo with `manifest.json`
2. A downloadable `.zip` release exists at the `downloadUrl`
3. `id` in `registry.json` matches `id` in `manifest.json`
4. Tested against the declared `minAppVersion`

## Plugin development

See the [plugin docs](https://github.com/sstraus/tuicommander/blob/main/docs/plugins.md) for the full API reference and examples.

Join [TUICommander & Co on Discord](https://discord.gg/4DQ7Ah6hSh) and use **#plugins** in the **TUICommander** category to showcase and discuss plugins, ask for plugin development help, or request plugins. The server is checked once a day. Report reproducible bugs in [GitHub issues](https://github.com/sstraus/tuicommander-plugins/issues).
