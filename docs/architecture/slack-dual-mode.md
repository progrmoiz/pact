# Slack Adapter: Dual-Mode Architecture

## Decision Date: 2026-03-18

## The Two Modes

Pact supports two Slack integration modes, auto-detected from environment variables:

### Solo Mode (Invisible Polling)
- **Token:** `PACT_SLACK_USER_TOKEN` (`xoxp-`)
- **How it works:** Polls `conversations.history` on a timer
- **Visibility:** Invisible. No bot in channels. No one knows you're running it.
- **Events:** Not supported. User tokens cannot receive Slack events (not even on free plans).
- **Follow-up DMs:** Sends as you (the authenticated user). No interactive buttons — includes CLI commands instead.
- **Best for:** Individual users tracking their own commitments privately.

### Team Mode (Real-Time Events)
- **Tokens:** `PACT_SLACK_BOT_TOKEN` (`xoxb-`) + `PACT_SLACK_APP_TOKEN` (`xapp-`)
- **How it works:** Socket Mode via `@slack/bolt`. Real-time event delivery.
- **Visibility:** Bot is visible. Must be invited to channels: `/invite @PactBot`
- **Events:** Real-time `message` events for all channels the bot is in.
- **Follow-up DMs:** Sends as the bot. Interactive buttons (Done, Snooze 3d, Cancel) work because Bolt handles `block_actions`.
- **Best for:** Teams where everyone's commitments are tracked. The bot follows up with each person.

## Why User Tokens Can't Receive Events

This is a fundamental Slack architecture constraint, not a bug:

1. **Slack Events API** (both Socket Mode and HTTP) dispatches events to the **bot user**
2. Events fire when the **bot** is present in a channel
3. **User tokens** (`xoxp-`) are for REST API calls only — they read history, post messages, etc.
4. The `xapp-` (app-level token) establishes the WebSocket transport, but events are routed to the bot

This applies to all Slack plans: Free, Pro, Business+, Enterprise Grid. It's not a tier limitation.

## Architecture

```
pact ingest --slack

  Token detection (src/adapters/slack/types.ts):
  ┌─────────────────────┐  ┌──────────────────────────┐
  │ USER_TOKEN only?     │  │ BOT_TOKEN + APP_TOKEN?    │
  │ → SlackPoller        │  │ → SlackListener           │
  │   (polling)          │  │   (Socket Mode events)    │
  └──────────┬──────────┘  └────────────┬─────────────┘
             │                          │
             ▼                          ▼
  ┌──────────────────────────────────────────────────┐
  │  Shared pipeline (src/adapters/slack/shared.ts)  │
  │  Pre-filter → Batcher → Extract → Store          │
  └──────────────────────────────────────────────────┘
```

Both strategies share:
- Channel discovery, scope filtering, username resolution (`shared.ts`)
- Pre-filter, batcher, extraction engine, dedup, storage
- Lock management, poll state persistence

## File Structure

```
src/adapters/slack/
  types.ts    — SlackIngestionStrategy interface, token detection, mode types
  shared.ts   — Shared utilities: channel discovery, scope, username resolution, batch processing
  poller.ts   — SlackPoller class (solo mode)
  listener.ts — SlackListener class (team mode)
  index.ts    — Entry point: auto-detects mode, starts the right strategy
```

## Follow-Up Behavior by Mode

| Behavior | Solo (user token) | Team (bot token) |
|----------|-------------------|------------------|
| DM sender | You (the user) | The bot |
| Interactive buttons | No (dead without Bolt) | Yes (Bolt handles clicks) |
| Fallback | CLI commands in message text | Buttons + CLI commands |
| `registerSlackActions()` | Not called | Called during listener startup |

## Environment Variables

```bash
# Solo mode
PACT_SLACK_USER_TOKEN=xoxp-...

# Team mode
PACT_SLACK_BOT_TOKEN=xoxb-...
PACT_SLACK_APP_TOKEN=xapp-...

# Shared (both modes)
PACT_SCOPE_CHANNELS=engineering,product
PACT_SCOPE_PEOPLE=samad,jawad
PACT_SLACK_POLL_INTERVAL=60          # seconds (solo mode only)
PACT_MAX_CHANNELS_PER_CYCLE=40       # rate limit safety (solo mode only)
PACT_BATCH_WINDOW_MS=300000          # 5 min batch window
```

## Why This Matters for the Future

- **Team mode is the growth path.** Solo is for bootstrapping — one person tracking their own promises. Team mode is the real product: a team installs PactBot, it tracks everyone's commitments, follows up with each person, and surfaces team accountability.
- **The strategy pattern means adding new ingestion methods is trivial.** HTTP Events API, Kafka, webhooks — just implement `SlackIngestionStrategy`.
- **The shared pipeline ensures consistency.** Whether a message comes from polling or events, it goes through the same pre-filter, batcher, extractor, and dedup. No divergence.
