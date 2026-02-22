# TUI Commander Plugin Registry

Community plugin registry for [TUI Commander](https://github.com/sstraus/tui-commander).

## registry.json

The app fetches `registry.json` from this repo to populate the Browse tab in Settings > Plugins.

### Entry format

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What it does",
  "author": "your-github-username",
  "latestVersion": "1.0.0",
  "minAppVersion": "0.4.0",
  "capabilities": [],
  "downloadUrl": "https://github.com/you/my-plugin/releases/latest/download/my-plugin.zip"
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique plugin ID (matches `manifest.json`) |
| `name` | yes | Display name |
| `description` | yes | Short description |
| `author` | yes | GitHub username or org |
| `latestVersion` | yes | Latest published version (semver) |
| `minAppVersion` | yes | Minimum TUI Commander version required |
| `capabilities` | yes | Array of required capabilities (see docs) |
| `downloadUrl` | yes | Direct URL to the plugin `.zip` file |

## Submitting a plugin

Open a PR adding your entry to `registry.json`. Make sure:

1. Your plugin has a public GitHub repo with a `manifest.json`
2. A downloadable `.zip` release exists at the `downloadUrl`
3. The `id` in `registry.json` matches the `id` in your `manifest.json`
4. You have tested the plugin against the `minAppVersion`

## Plugin development

See the [TUI Commander plugin docs](https://github.com/sstraus/tui-commander/blob/main/docs/plugins.md) for the full API reference, examples, and the `manifest.json` format.
