# Plan Tracker

Tracks Markdown plans discovered through TUICommander's `plan-file` events and the active repository's `plans/` directory.

New and explicitly active plans open as pinned background tabs without stealing focus. Each plan opens once per app run: a tab the user closes stays closed when the repository is re-entered. The plugin also watches `plans/` for files created while TUICommander is running.

## Capabilities

- `fs:read` — read active-plan markers
- `fs:list` — discover Markdown plans
- `fs:watch` — react to plan directory changes
- `ui:markdown` — open plan files as background tabs
