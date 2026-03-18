# Slack Setup

Pact connects to Slack via Socket Mode — no public URL needed, works behind firewalls.

## Two modes

| Mode | Token type | What it sees | Bot visible? |
|------|-----------|-------------|-------------|
| **Solo** (recommended) | User token (`xoxp-`) | Everything you see — channels, DMs, group DMs | No |
| **Team** | Bot token (`xoxb-`) | Only channels the bot is invited to | Yes |

**Solo mode** is invisible. No bot joins channels. No one knows you're running it. It piggybacks on your own Slack session.

## Setup (5 minutes)

### 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**

Pick your workspace, then paste the contents of [`slack-manifest.json`](../slack-manifest.json) from this repo.

### 2. Get your tokens

**App-level token** (for Socket Mode connection):
- Go to **Basic Information** → **App-Level Tokens**
- Click **Generate Token and Scopes**
- Add scopes: `connections:write` and `authorizations:read`
- Name it anything (e.g., "pact-socket")
- Copy the `xapp-` token

**User token** (for solo mode):
- Go to **Install App** → **Install to Workspace**
- Authorize the app
- Copy the **User OAuth Token** (`xoxp-`)

### 3. Configure environment

Create a `.env` file in your pact directory (or export in your shell):

```bash
PACT_SLACK_BOT_TOKEN=xoxp-your-user-token
PACT_SLACK_APP_TOKEN=xapp-your-app-token
PACT_LLM_API_KEY=sk-ant-your-anthropic-key
```

### 4. Start listening

```bash
pact ingest --slack
```

You should see:
```
Connected to Slack. Listening for commitments...
Press Ctrl+C to stop.
```

## How it works

1. **Passive listening** — Pact receives every message from channels/DMs you're in
2. **Pre-filter** — 17 regex patterns catch commitment signals ("I'll", "by Friday", "let me handle"). ~97-99% of messages are silently dropped here. Zero LLM cost.
3. **Batching** — Messages that pass the filter are batched per channel in 5-minute windows
4. **Extraction** — One LLM call per batch. Claude Haiku extracts who, what, to whom, deadline, confidence
5. **Storage** — Commitments stored locally in `~/.pact/commitments.db`

## What gets caught

Messages like:
- "I'll send the report by Friday"
- "Let me handle the deployment"
- "I've got the PR review, will do it by EOD"
- "Sure, I can take care of that by next week"

Messages that get ignored:
- "Hey, how's it going?"
- "Nice work on the launch"
- "I might look into that sometime"
- "Has anyone seen the new design?"

## Scopes explained

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages in public channels |
| `channels:read` | Get channel names for context |
| `groups:history` | Read messages in private channels |
| `groups:read` | Get private channel names |
| `im:history` | Read your 1:1 DMs |
| `im:read` | Get DM channel info |
| `mpim:history` | Read group DMs |
| `mpim:read` | Get group DM info |
| `users:read` | Resolve `<@U123>` mentions to names |
| `chat:write` (bot) | Send follow-up nudge DMs |
| `im:write` (bot) | Open DM channels for nudges |

## Follow-up nudges via Slack DM

After commitments are tracked, you can send nudges for overdue items:

```bash
pact follow-up --via slack-dm --dry-run   # preview
pact follow-up --via slack-dm             # send DMs
```

Nudge DMs include interactive buttons: **Done**, **Snooze 3d**, **Cancel**.

> **Note:** Button clicks only work while `pact ingest --slack` is running (the Bolt app handles button interactions). If you run follow-up via cron, buttons will appear but won't respond until the ingest daemon is running.

## Running as a daemon

For always-on monitoring, run with a process manager:

```bash
# Using nohup
nohup pact ingest --slack >> ~/.pact/slack.log 2>&1 &

# Using pm2
pm2 start "pact ingest --slack" --name pact-slack

# Using systemd (create a service file)
```

## Cost

With Claude Haiku and the pre-filter + batching:
- ~$0.10/month for a typical workspace
- Pre-filter drops 97-99% of messages before LLM
- Batching reduces API calls to ~1 per channel per 5 minutes

## Troubleshooting

**"Connected" but no messages received:**
- Reinstall the app: Install App → Reinstall to Workspace
- Verify event subscriptions are enabled: Event Subscriptions → On
- Check "Subscribe to events on behalf of users" has all 4 message events
- Make sure you're using the `xoxp-` (user) token, not `xoxb-` (bot)

**Pre-filter too aggressive (missing commitments):**
- The pre-filter is intentionally conservative. If you notice missed commitments, the regex patterns are in `src/pre-filter.ts` — add patterns for your team's language.

**High LLM costs:**
- Increase batch window: edit `BATCH_WINDOW_MS` in `src/batcher.ts`
- Use a cheaper model: `PACT_LLM_MODEL=claude-haiku-4-5-20251001`
