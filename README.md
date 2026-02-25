# TUI Commander Plugins

Community plugin registry and distributable plugins for [TUICommander](https://github.com/sstraus/tuicommander).

## Plugins

| Plugin | Description | Capabilities |
|--------|-------------|-------------|
| [mdkb-dashboard](mdkb-dashboard/) | mdkb knowledge base status, memories, config | `exec:cli`, `fs:read`, `ui:panel`, `ui:ticker` |

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
