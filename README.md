# pact — Never drop the ball.

One command shows everything you're dropping — unreplied DMs, pending PR reviews, unanswered questions, forgotten promises, ignored emails.

```bash
$ pact open

  ●●●●○  slack.dm              Reply to Sarah                        18h  Sarah
  ●●●●○  gmail.unreplied       Re: Q2 Planning                      24h  James
  ●●●○○  github.pr-review      Fix N+1 query for specialist agents    6h  muhammad-jawad-92
  ●●●○○  slack.question        Waiting for answer in #product        12h  me
  ●●○○○  commitment            Ship the landing page                  2d  —
```

## Install

```bash
npm install -g pact-cli
```

## Quick Start

```bash
# Set your identity
pact whoami "Moiz"

# Connect platforms
export PACT_SLACK_USER_TOKEN=xoxp-...
export PACT_GITHUB_TOKEN=ghp_...
pact init gmail

# Scan everything
pact scan

# See what you're dropping
pact open
```

## What It Detects

| Type | Source | How |
|------|--------|-----|
| `slack.dm` | Unreplied DMs | API — last message from someone else |
| `slack.mention` | Unresponded @mentions | API — no reply in thread |
| `slack.question` | Your unanswered questions | API — questions you asked with no response |
| `github.pr-review` | Pending PR reviews | API — review-requested for you |
| `github.issue` | Assigned issues | API — issues assigned to you |
| `gmail.unreplied` | Unreplied emails (To: you) | API — last message not from you |
| `gmail.cc` | CC'd emails (lower priority) | API — same, with 0.25x urgency |
| `commitment` | Broken promises | LLM — extracted from meeting notes, messages |

Scanners are **zero LLM cost** — pure API calls. Only commitment extraction uses an LLM.

## Commands

### The Main Command

```bash
pact open                          # all open loops, ranked by urgency
pact open --type slack.dm          # just unreplied DMs
pact open --source github          # just GitHub loops
pact open --json                   # machine-readable
```

### Scan Platforms

```bash
pact scan                          # auto-detect all configured platforms
pact scan --slack                  # Slack only
pact scan --github                 # GitHub only
pact scan --gmail                  # Gmail only
```

### Quick Add (No LLM)

```bash
pact add "Ship the landing page" --deadline friday --to "Sarah"
pact remind "Check deployment logs" --in 3d
```

### Extract Commitments from Text (LLM)

```bash
echo "I'll send the report by Friday" | pact extract
echo "Meeting notes..." | pact extract --source slack --channel general
```

### Manage Commitments

```bash
pact list                          # all active
pact list --overdue                # past deadline
pact resolve 01HXK --note "Done"   # mark done
pact snooze 01HXK --days 3         # push deadline
pact edit 01HXK --what "Updated"   # edit text
```

### Dismiss Open Loops

```bash
pact dismiss "gmail.unreplied:abc123"        # single
pact dismiss --type gmail.cc                  # all CC'd emails
pact dismiss --from "*.company.com"           # by sender domain
pact dismiss --older-than 7d                  # by age
```

### Follow-up & Reminders

```bash
pact follow-up --dry-run                     # preview overdue nudges
pact follow-up --via slack-dm                # send individual nudges
pact follow-up --format digest               # one consolidated DM
pact follow-up --format digest --limit 5     # top 5 only
```

### Background Scanning

```bash
pact install-cron                  # auto-scan every 30min + daily digest
pact install-cron --show           # preview cron entries
pact install-cron --remove         # uninstall
```

### Analytics

```bash
pact stats                         # per-person delivery rates
pact stats --who "Moiz"            # detail for one person
pact digest --period week          # weekly summary
```

### Diagnostics

```bash
pact doctor                        # health checks for all integrations
pact whoami Moiz                   # set identity
pact identities list               # list all identities
pact identities merge 01AB 02CD    # merge duplicates
```

## Urgency Scoring

Every open loop gets a 0.0–1.0 urgency score based on type and age:

| Type | Ramp | Max | Example |
|------|------|-----|---------|
| `slack.dm` | Fast (16h) | 0.95 | Critical at 10h |
| `gmail.unreplied` | Medium (24h) | 0.90 | Critical at ~20h |
| `slack.mention` | Medium (24h) | 0.90 | Critical at ~20h |
| `slack.question` | Slow (32h) | 0.85 | Your question, not theirs |
| `github.pr-review` | Slow (48h) | 0.90 | PRs can wait a day |
| `gmail.cc` | Very slow (96h) | 0.50 | CC = FYI, usually |
| `commitment` | Deadline-based | 1.0 | Spikes when overdue |

## For AI Agents

Pact includes an MCP server so Claude Code, Cursor, or any MCP-compatible agent can query your open loops:

```bash
pact serve --mcp
```

**7 MCP tools:** `pact_list`, `pact_get`, `pact_resolve`, `pact_extract`, `pact_open`, `pact_dismiss`, `pact_add`

All read commands support `--json` and auto-detect non-TTY output for piping.

## Live Monitoring

```bash
pact ingest --slack                # poll Slack for new messages, extract commitments
```

## Gmail Setup

```bash
pact init gmail                    # walks through Google OAuth setup
```

Requires a Google Cloud project with Gmail API enabled. See `pact init gmail` for step-by-step instructions.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PACT_LLM_API_KEY` | Anthropic API key (for `extract`) |
| `PACT_LLM_MODEL` | Model override (default: `claude-haiku-4-5-20251001`) |
| `PACT_USER` | Your name (alternative to `pact whoami`) |
| `PACT_SLACK_USER_TOKEN` | Slack user token (for scan + ingest) |
| `PACT_SLACK_BOT_TOKEN` | Slack bot token (for DM reminders) |
| `PACT_GITHUB_TOKEN` | GitHub PAT (needs repo scope + SSO auth for org repos) |
| `PACT_GMAIL_CLIENT_ID` | Google OAuth client ID |
| `PACT_GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `PACT_SCOPE_CHANNELS` | Limit Slack scanning to specific channels |
| `PACT_SCOPE_PEOPLE` | Limit Slack scanning to specific people's DMs |

## How It Works

```
Text / Slack / GitHub / Gmail
        │
        ▼
   ┌─────────┐     ┌──────────────┐
   │ Scanners │────▶│ Open Loops   │──▶ pact open
   │ (API)    │     │ (SQLite)     │
   └─────────┘     └──────────────┘
        │                 │
   ┌─────────┐     ┌──────────────┐
   │ Extract  │────▶│ Commitments  │──▶ pact list
   │ (LLM)   │     │ (SQLite)     │
   └─────────┘     └──────────────┘
                          │
                    ┌──────────────┐
                    │ Follow-up    │──▶ Slack DM / stdout
                    │ (Nudges)     │
                    └──────────────┘
```

- **Scanners** detect open loops via platform APIs — zero LLM cost
- **Extraction** uses an LLM to find commitments in text
- **Both feed into urgency scoring** — sorted by what matters most
- **Everything local** — SQLite at `~/.pact/commitments.db`

## License

MIT
