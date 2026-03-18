---
name: pact-core
description: Track promises and commitments from the terminal. Extract, query, resolve.
triggers:
  - commitment
  - promise
  - "I'll do"
  - "by Friday"
  - overdue
  - "what did I promise"
  - "what's pending"
tools:
  - bash
---

# Pact — Commitment Tracker

Track every promise you make. From the terminal.

## Extract commitments from text

```bash
echo "I'll send the report by Friday and review the PR tomorrow" | pact extract
```

Pipe any text — meeting notes, messages, journal entries. Pact uses an LLM to find commitments.

## List commitments

```bash
pact list                    # all active
pact list --overdue          # past deadline
pact list --who "Moiz"       # filter by person
pact list --json             # machine-readable
```

## Resolve a commitment

```bash
pact resolve 01HXK --note "Shipped in PR #423"
pact resolve 01HXK --cancel
```

IDs are partial-match — first 4-8 chars is enough if unambiguous.

## Snooze a commitment

```bash
pact snooze 01HXK --days 3
pact snooze 01HXK --until friday
pact snooze 01HXK --until 2026-03-25
```

## Set your identity

```bash
pact whoami Moiz
```

Or set `PACT_USER=Moiz` in your environment.

## Diagnostics

```bash
pact doctor
```

## Notes

- All read commands support `--json` for programmatic use
- Non-TTY output auto-switches to JSON (pipe-friendly)
- IDs are ULIDs — time-sortable, unique
- Data stored locally at `~/.pact/commitments.db`
- Requires `PACT_LLM_API_KEY` (Anthropic) for extraction
