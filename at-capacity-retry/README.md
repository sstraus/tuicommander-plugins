# At-Capacity Retry

Codex sometimes ends a turn with:

```
⚠ Selected model is at capacity. Please try a different model.
```

The turn is lost, but the model is usually available again after a short pause.
This plugin detects the message, waits **1 minute**, then sends `retry last request`
to the agent — so an unattended run continues on its own.

## Circuit breaker

More than **3 retries in one rolling hour** means the capacity problem is not
transient. The plugin then **blocks** that session:

- all pending and future retries stop
- a ticker is pinned and a warning sound plays
- an item appears in the Activity Center

Your own input in that terminal unblocks the session and clears the hour budget
— the human took over, so the plugin trusts the new state.

## When a retry is skipped

The retry is dropped (not sent, and not counted against the hour budget) when:

| Condition | Reason |
|---|---|
| The machine slept through the delay | The incident on screen is stale |
| The agent went busy after the detection | It resumed work on its own |
| Text sits unsent in the input box | You are typing |

## Repeat detections

A TUI repaints its scrollback, so the same warning line reaches the plugin many
times. One incident stays one incident: a scheduled retry absorbs every further
detection, and detections closer than 20s are ignored.

## Configuration

Optional `data/config.json` in the plugin directory. Defaults:

```json
{
  "retryDelayMs": 60000,
  "maxRetriesPerWindow": 3,
  "windowMs": 3600000,
  "retryText": "retry last request",
  "detectDebounceMs": 20000,
  "tickerIntervalMs": 5000
}
```

## Stats

*Settings → Plugins → At-Capacity Retry → Dashboard*, or the Activity Center
item, shows incidents, retries sent and skipped, breaker trips, per-session
state, and the last 20 events. Stats persist in `data/stats.json`.

## Scope

`agentTypes: ["codex"]` — output watchers and events only fire for terminals
that run Codex.

## Tests

```bash
node --test at-capacity-retry/scripts/main.test.js
```

No dependencies: the tests drive `main.js` with a fake host and fake timers.
