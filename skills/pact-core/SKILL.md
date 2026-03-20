---
name: pact-core
description: Track promises and open loops from the terminal. Detects unreplied Slack DMs, pending GitHub PR reviews, assigned issues, and commitments extracted from text — all ranked by urgency. Use when asking about commitments, promises, overdue items, open loops, "what am I dropping", or "what needs attention".
triggers:
  - commitment
  - promise
  - open loops
  - "what am I dropping"
  - "what needs attention"
  - unreplied
  - overdue
  - "I'll do"
  - "by Friday"
  - "what did I promise"
  - "what's pending"
tools:
  - bash
---

# Pact — Never Drop the Ball

Two systems working together:
1. **Open loops engine** — scans Slack and GitHub for things you're dropping (unreplied DMs, pending PR reviews, assigned issues)
2. **Commitment tracker** — extracts promises from text via LLM, tracks deadlines, nudges

## The main command: `pact open`

```bash
pact open                          # all open loops, ranked by urgency
pact open --type slack.dm          # just unreplied DMs
pact open --source github          # just GitHub loops
pact open --json                   # machine-readable
```

Shows everything — scanner results + overdue commitments — merged and sorted by urgency (0.0-1.0).

## Scan platforms

```bash
pact scan                          # auto-detect configured platforms
pact scan --slack                  # Slack: unreplied DMs + unanswered mentions
pact scan --github                 # GitHub: pending PR reviews + assigned issues
```

Scanners cache results in SQLite. Stale loops auto-purge when no longer detected.

## Quick-add (no LLM)

```bash
pact add "Ship the landing page" --deadline friday --to "Sarah"
pact remind "Check deployment logs" --in 3d
pact remind "Quarterly review prep" --on 2026-04-01
```

## Extract commitments from text (LLM)

```bash
echo "I'll send the report by Friday and review the PR tomorrow" | pact extract
echo "Meeting notes..." | pact extract --source slack --channel general
echo "Preview first..." | pact extract --dry-run
```

## Manage commitments

```bash
pact list                          # all active
pact list --overdue                # past deadline
pact list --who "Moiz"             # filter by person
pact resolve 01HXK --note "Done"   # mark done (partial ID works)
pact resolve 01HXK --cancel        # cancel
pact snooze 01HXK --days 3         # push deadline
pact edit 01HXK --what "Updated text" --deadline friday
```

## Dismiss open loops

```bash
pact dismiss "github.issue:progrmoiz/yaara-website:97"
```

## Analytics

```bash
pact stats                         # per-person delivery rates
pact stats --who "Moiz"            # detail for one person
pact digest --period week          # weekly summary
pact digest --period day           # daily summary
```

## Identity & diagnostics

```bash
pact whoami Moiz                   # set your identity
pact identities list               # list all identities
pact identities merge 01AB 02CD    # merge duplicates
pact doctor                        # health checks
pact schema commitment             # dump JSON schema
```

## Follow-up & nudges

```bash
pact follow-up                     # stdout nudges for overdue commitments
pact follow-up --via slack-dm      # send nudges via Slack DM
pact follow-up --dry-run           # preview without sending
```

## MCP server

```bash
pact serve --mcp                   # start MCP server (stdio)
```

7 tools: `pact_list`, `pact_get`, `pact_resolve`, `pact_extract`, `pact_open`, `pact_dismiss`, `pact_add`

## Live monitoring

```bash
pact ingest --slack                # poll Slack for new messages, extract commitments
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PACT_LLM_API_KEY` | Anthropic API key (for extract) |
| `PACT_SLACK_USER_TOKEN` | Slack user token (for scan/ingest) |
| `PACT_SLACK_BOT_TOKEN` | Slack bot token (for follow-up DMs) |
| `PACT_GITHUB_TOKEN` | GitHub PAT (for scan — needs repo + SSO auth for org repos) |
| `PACT_USER` | Default identity (alternative to `pact whoami`) |

## Notes

- All read commands support `--json` for programmatic use
- Non-TTY output auto-switches to JSON (pipe-friendly)
- IDs are ULIDs — time-sortable, partial-match supported
- Data stored locally at `~/.pact/commitments.db` (SQLite WAL mode)
- Open loop types use `{source}.{noun}` convention: `slack.dm`, `github.pr-review`, `commitment`
- Urgency scoring: slack.dm ramps fastest (0.95 at 10h), github.pr-review slower (urgent at 24h+)
