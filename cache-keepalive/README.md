# Cache Keepalive

Prevents Claude API prompt cache expiry by sending minimal keepalive messages to idle Claude Code sessions.

## Why

Claude Code uses **5-minute ephemeral prompt caching** (`ephemeral_5m`). The cache has a sliding TTL: each API call that hits the cache resets the 5-minute timer at no extra cost. But if you step away for more than 5 minutes, the cache expires and the next turn rebuilds it at full price.

**Empirically verified** (CC v2.1.89, Opus 4.6): all cached tokens go through `ephemeral_5m_input_tokens`. The `ephemeral_1h_input_tokens` counter is always zero. Claude Code does not use 1-hour caching despite the API supporting it ([anthropics/claude-code#2603](https://github.com/anthropics/claude-code/issues/2603), open since July 2025).

### Cost math

| Scenario | Cost per 100k context (Opus) |
|----------|------------------------------|
| Cache miss (full input) | $1.50 |
| Cache hit (0.1x) | $0.15 |
| Single keepalive cost | ~$0.15 (cache read) + negligible output |
| 3 keepalives vs 1 cache miss | $0.45 vs $1.50 = **$1.05 saved** |

The plugin pays for itself after the first avoided cache miss.

### Cache pricing reference

| | Write | Read (hit) |
|---|---|---|
| 5-min cache | 1.25x base input | 0.1x base input |
| 1-hour cache | 2.0x base input | 0.1x base input |

Source: [Anthropic Prompt Caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

## How it works

1. Monitors `shell-state` events from Claude Code terminals
2. When a session is idle for ~4.5 minutes (configurable), sends a minimal message (`.`) to trigger an API call
3. The API call hits the cached context (0.1x cost), resetting the 5-minute TTL
4. Repeats up to N times (default: 3), then stops

With default settings, cache life extends from 5 minutes to ~23 minutes of inactivity.

## Configuration

The plugin stores config in its sandboxed data directory. Defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `ttlMs` | `300000` (5 min) | Cache TTL matching Anthropic's ephemeral_5m |
| `marginMs` | `30000` (30s) | Send keepalive this long before TTL expires |
| `maxKeepalives` | `3` | Max keepalives per idle stretch, then stop |
| `checkIntervalMs` | `30000` (30s) | How often to check idle sessions |
| `message` | `"."` | Message sent to terminal (shortest possible) |

To customize, create a `config.json` in the plugin's data directory or use the TUICommander plugin data API.

## Analytics and Verification

The plugin tracks every keepalive and verifies cache hit/miss by capturing token usage from Claude Code's output.

### Activity Center dashboard

Click **Cache Keepalive Stats** in the Activity Center dropdown to see:

- **Cost Impact**: estimated savings vs keepalive cost (net savings)
- **Token Breakdown**: cache read, cache creation, and output tokens
- **Effectiveness**: hit rate, total sent/hit/miss
- **Recent History**: last 20 keepalives with per-event token data

### Ticker

After each keepalive, the status bar ticker briefly shows `Cache HIT` or `Cache MISS` with the cache read token count.

### Manual verification

Check your Claude Code session JSONL directly:

```bash
# Last 5 responses with cache breakdown
tail -20 ~/.claude/projects/*/conversation.jsonl | \
  grep -o '"cache_read_input_tokens":[0-9]*\|"cache_creation_input_tokens":[0-9]*'
```

A keepalive cache **hit** shows high `cache_read_input_tokens` and zero/low `cache_creation_input_tokens`. A cache **miss** shows the opposite.

### How the savings estimate works

Each cache read token costs 0.1x of the full input price. Without the keepalive, those tokens would be re-sent at full price (cache miss). The plugin calculates:

- **Savings** = `cache_read_tokens * (input_price - cache_read_price)`
- **Cost** = `cache_read_tokens * cache_read_price + output_tokens * output_price`
- **Net** = savings - cost

Using Opus pricing ($15/M input, $1.50/M cache read).

## Install

Available in TUICommander's plugin registry: **Settings > Plugins > Browse > Cache Keepalive > Install**.

Or manually: copy `manifest.json` and `main.js` to `~/Library/Application Support/com.tuic.commander/plugins/cache-keepalive/`.

## Requirements

- TUICommander v0.9.8+
- Capabilities: `pty:write`, `ui:ticker`
- Only activates for Claude Code sessions (`agentTypes: ["claude"]`)
