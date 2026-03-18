# Slack Setup

Pact has two Slack modes. Pick the one that fits.

## Two Modes

| Mode | Token | How it works | Bot visible? | Follow-up DMs |
|------|-------|-------------|-------------|---------------|
| **Solo** | User token (`xoxp-`) | Polls history every 60s | No — invisible | Sends as you, CLI commands |
| **Team** | Bot token (`xoxb-`) + App token (`xapp-`) | Real-time Socket Mode events | Yes — must invite bot | Sends as bot, interactive buttons |

**Solo** = you tracking your own commitments privately. No one knows.
**Team** = a bot tracking everyone's commitments. Follows up with each person.

## Solo Mode Setup (5 minutes)

### 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**

Pick your workspace, then paste the contents of [`slack-manifest.json`](../slack-manifest.json).

### 2. Get your user token

- Go to **Install App** → **Install to Workspace**
- Authorize the app
- Copy the **User OAuth Token** (`xoxp-`)

### 3. Configure

```bash
# .env
PACT_SLACK_USER_TOKEN=xoxp-your-user-token
PACT_LLM_API_KEY=sk-ant-your-anthropic-key
```

### 4. Start

```bash
pact ingest --slack
```

You should see:
```
Solo mode: authenticated as moiz on TeamAI (T064FAB0E1Z)
Found 112 channels/DMs to monitor (no scope set — polling all)
Polling every 60s. Press Ctrl+C to stop.
```

## Team Mode Setup

### 1. Create the Slack app (same manifest)

### 2. Get bot + app tokens

**Bot token:**
- Go to **Install App** → **Install to Workspace**
- Copy the **Bot User OAuth Token** (`xoxb-`)

**App-level token (for Socket Mode):**
- Go to **Basic Information** → **App-Level Tokens**
- Click **Generate Token and Scopes**
- Add scopes: `connections:write` and `authorizations:read`
- Copy the `xapp-` token

### 3. Configure

```bash
# .env
PACT_SLACK_BOT_TOKEN=xoxb-your-bot-token
PACT_SLACK_APP_TOKEN=xapp-your-app-token
PACT_LLM_API_KEY=sk-ant-your-anthropic-key
```

### 4. Invite the bot

In each channel you want to monitor:
```
/invite @PactBot
```

### 5. Start

```bash
pact ingest --slack
```

You should see:
```
Team mode: authenticated as pact (bot) on TeamAI (T064FAB0E1Z)
Connected to Slack via Socket Mode. Listening for commitments...
Note: Bot must be invited to channels to receive events. Use /invite @YourBot
```

## Scope Filtering (Both Modes)

Limit which channels and people to monitor:

```bash
# Only monitor these channels
PACT_SCOPE_CHANNELS=engineering,product

# Only monitor DMs with these people
PACT_SCOPE_PEOPLE=samad,jawad

# Combined = union: #engineering + #product + Samad's DM + Jawad's DM
```

Without scope, Pact monitors everything you have access to. With scope, it monitors only what you specify.

## How It Works

1. **Message arrives** — via polling (solo) or Socket Mode event (team)
2. **Pre-filter** — 17 regex patterns catch commitment signals ("I'll", "by Friday", "let me handle"). 97-99% of messages are dropped here. Zero LLM cost.
3. **Batching** — Messages that pass the filter are batched per channel in 5-minute windows
4. **Extraction** — One LLM call per batch. Claude Haiku extracts who, what, to whom, deadline, confidence
5. **Dedup** — Content hash + message ID + INSERT OR IGNORE prevents duplicates
6. **Storage** — Commitments stored locally in `~/.pact/commitments.db`

## Follow-Up Nudges

```bash
pact follow-up --via slack-dm --dry-run   # preview
pact follow-up --via slack-dm             # send DMs
```

**Solo mode:** DMs come from you. Include CLI resolve/snooze commands.
**Team mode:** DMs come from the bot. Include interactive buttons (Done, Snooze 3d, Cancel). Buttons work while `pact ingest --slack` is running.

## Scopes Explained

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages in public channels |
| `channels:read` | Get channel names for context |
| `groups:history` | Read messages in private channels |
| `groups:read` | Get private channel names |
| `im:history` | Read 1:1 DMs |
| `im:read` | Get DM channel info |
| `mpim:history` | Read group DMs |
| `mpim:read` | Get group DM info |
| `users:read` | Resolve `<@U123>` mentions to names |
| `chat:write` (bot) | Send follow-up nudge DMs |
| `im:write` (bot) | Open DM channels for nudges |

## Running as a Daemon

```bash
# nohup
nohup pact ingest --slack >> ~/.pact/slack.log 2>&1 &

# pm2
pm2 start "pact ingest --slack" --name pact-slack
```

## Cost

With Claude Haiku and pre-filter + batching: ~$0.10/month for a typical workspace.

## Troubleshooting

**Solo mode — no messages detected:**
- Verify `PACT_SLACK_USER_TOKEN` starts with `xoxp-`
- Check `pact doctor` for token status
- Try with scope: `PACT_SCOPE_CHANNELS=general pact ingest --slack`

**Team mode — no events received:**
- Bot must be invited to channels: `/invite @PactBot`
- Check event subscriptions are enabled in the Slack app config
- Verify `PACT_SLACK_APP_TOKEN` starts with `xapp-`

**Pre-filter too aggressive:**
- Patterns are in `src/pre-filter.ts` — add patterns for your team's language
