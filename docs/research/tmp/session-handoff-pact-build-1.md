# Session Handoff — Pact CLI Build (Session 1)
### Continue from here in the next session

*Session date: 2026-03-18 (3:18 AM – 10:25 AM PKT)*
*Previous sessions: None (first session). Research was done in life-os repo prior session — see `/Users/moiz/Documents/Code/life-os/content/research/pact/`*
*Status: Pact CLI fully built and tested. Scope filtering implemented but uncommitted. Slack polling works on TeamAI Enterprise Grid.*

---

## What This Session Was About

Built Pact from research blueprints to a working CLI tool. Pact is an open-source commitment tracker that extracts promises from text (stdin, Slack messages) using LLM, stores them in local SQLite, and provides query/resolve/follow-up capabilities.

The session covered: Phase 1 (solo CLI core), Phases 3-5 (Slack adapter, follow-up engine, MCP server), debugging Slack Socket Mode (doesn't work on Enterprise Grid — switched to polling), implementing 3-layer deduplication, rate limit safety, and scope filtering for channel/people selection.

Research and blueprints existed from a prior session at `/Users/moiz/Documents/Code/life-os/content/research/pact/`. This session was pure implementation.

## What We Decided

### Socket Mode → Polling
Socket Mode doesn't deliver user token events on Enterprise Grid. Switched to `conversations.history` polling with user token (`xoxp-`). This is what slackdump (6K stars) does. Research at `/tmp/reference-projects/slackdump/`.

### 3-Layer Dedup Architecture
1. **Poll state** (`~/.pact/slack-poll-state.json`) — `{channelId: lastTs}` per channel
2. **Content hash** — SHA256 of `who::what::channel`, checked before insert
3. **Message ID unique index** — `UNIQUE(source_platform, source_message_id)` + `INSERT OR IGNORE`

### Scope Filtering (Michael Livshits design)
Two env vars, union semantics: `PACT_SCOPE_CHANNELS=engineering,product` + `PACT_SCOPE_PEOPLE=samad,jawad` = poll only those channels + DMs with those people. `people` means "conversations WITH these people" (pre-poll filter), not "messages FROM these people". Universal `Scope` type works for all future adapters.

### Rate Limit Safety
Max 40 channels per poll cycle (configurable via `PACT_MAX_CHANNELS_PER_CYCLE`). Channels sorted by `updated` timestamp — most active first. With scope filtering, typically 2-5 channels instead of 112.

### Batch Window Configurable
`PACT_BATCH_WINDOW_MS` env var (default 300000 = 5 min). Set to 10000 for testing.

### DM Participant Context
Extraction prompt receives participant names for DMs so `to_whom` is auto-populated (e.g., DM with Samad → `to_whom: "Abdul Samad"`).

## What Changed in the Codebase

### Created (committed)
| File | Description |
|------|-------------|
| `package.json` | pact-cli v0.1.0, ESM, all dependencies |
| `tsconfig.json` | ES2022, Node16 module resolution |
| `.gitignore` | node_modules, dist, .env, *.db |
| `bin/pact.js` | Shebang entry point |
| `src/types.ts` | Commitment, Identity, AdapterOutput, FollowUpConfig, NudgeCandidate |
| `src/utils.ts` | ULID gen, date parsing, TTY detection, parseDuration |
| `src/db.ts` | SQLite connection, WAL mode, migration runner, content_hash column |
| `src/migrations/001_initial.sql` | 3 tables, 6 indexes (source of truth, inlined in db.ts) |
| `src/extract.ts` | Anthropic API call, prompt loading, JSON parsing, confidence filter, ExtractionContext |
| `src/identity.ts` | Find-or-create identity by name+platform |
| `src/mutations.ts` | insertCommitment (with content hash dedup), resolveCommitment, snoozeCommitment, incrementNudge, markEscalated |
| `src/queries.ts` | listCommitments, getCommitmentById, getNudgeCandidates, partial ID match |
| `src/format.ts` | chalk table formatting, overdue highlighting, short IDs |
| `src/schemas.ts` | JSON schemas for `pact schema` command |
| `src/doctor.ts` | DB check, LLM check, identity, agents, scope check |
| `src/cli.ts` | Commander.js — 10 commands: extract, list, resolve, snooze, schema, doctor, whoami, ingest, follow-up, serve |
| `src/pre-filter.ts` | 17 regex patterns for commitment signals |
| `src/batcher.ts` | Channel-based time window batcher, configurable via env |
| `src/adapters/slack.ts` | Polling adapter: conversations.history, pre-filter, batch, extract, process lock, error recovery, scope filtering |
| `src/outputs/stdout.ts` | Terminal nudge output |
| `src/outputs/slack-dm.ts` | Slack DM nudge with Block Kit buttons |
| `src/follow-up.ts` | Follow-up engine: query overdue, format nudges, dispatch |
| `src/mcp.ts` | MCP server with 4 tools: pact_list, pact_get, pact_resolve, pact_extract |
| `prompts/extract.md` | Extraction prompt with participant context, solo-mode tuning |
| `skills/pact-core/SKILL.md` | Agent skill file for pact usage |
| `skills/pact-follow-up/SKILL.md` | Follow-up skill file |
| `README.md` | Full docs: install, setup, all 10 commands, Slack/MCP/follow-up |
| `docs/slack-setup.md` | Complete Slack setup guide with manifest |
| `docs/mcp-setup.md` | MCP server setup for Claude Code/Cursor |
| `slack-manifest.json` | Slack app manifest for one-click app creation |

### Uncommitted (scope filtering)
| File | Status |
|------|--------|
| `src/scope.ts` | **New** — Scope type + loadScope() from env vars |
| `src/adapters/slack.ts` | **Modified** — ChannelInfo extended with type/userId/name, resolveSlackScope(), listUsers(), scope-aware poll loop, better log labels |
| `src/doctor.ts` | **Modified** — scope check added |

## What Was NOT Done Yet

1. **Commit scope filtering** — code is written and builds clean, but not committed
2. **Update research docs** — `content/research/pact/05-adapters.md` and `09-build-plan.md` should reflect scope filtering
3. **Update `docs/slack-setup.md`** — add scope env vars documentation
4. **Update `.env` file** — add PACT_SCOPE_CHANNELS and PACT_SCOPE_PEOPLE
5. **MPIM scope resolution** — the `resolveSlackScope` checks MPIM members but may hit rate limits on large workspaces. Consider caching or skipping.
6. **Test scope with `listUsers` name matching** — "samad" needs to match "Abdul Samad". Current code matches on `real_name` (full) and `username`. May need partial/fuzzy matching.
7. **Phase 6-10 not started** — stats, digest, edit, identities, cloud dashboard
8. **GitHub repo not created** — code is local at `~/Documents/Code/pact/` only
9. **MCP server not tested live** — builds but not tested with Claude Code MCP config

## Research Conducted

### Prior Session Research (in life-os)
Full research at `/Users/moiz/Documents/Code/life-os/content/research/pact/` — 17 files covering system design, CLI spec, cloud spec, database schema, extraction engine, adapters, follow-up, skills, monetization, build plan. Blueprints at `blueprint-phase1.md` and `blueprint-phase3-5.md`.

### This Session Research
- **Slack Socket Mode + Enterprise Grid**: Socket Mode only delivers bot events, not user token events on Enterprise Grid. Confirmed by reading slackdump source code and Slack API docs.
- **Dedup patterns**: Studied slackdump (Go, 6K stars), slunk-mcp (Swift, content hash + version tracking), slack-free-backup-bot (Python, state.json timestamps). Reference repos at `/tmp/reference-projects/`.
- **Scope design**: Michael Livshits agent reviewed full architecture and recommended `places` + `people` pattern with env vars. No config files needed.

## Current State of Key Files

| File | Status |
|------|--------|
| `~/Documents/Code/pact/` | Local git repo, 3 commits, 1 uncommitted change |
| `~/.pact/commitments.db` | SQLite DB with test data (may need reset) |
| `~/.pact/slack-poll-state.json` | Poll state (may need reset for fresh test) |
| `~/.pact/whoami` | Set to "Moiz" |
| `~/.pact/ingest.lock` | May have stale lock — rm before testing |
| `~/Documents/Code/pact/.env` | Contains PACT_LLM_API_KEY + Slack tokens (gitignored) |

## Key Insights Worth Remembering

1. **Slack Enterprise Grid kills Socket Mode for user tokens.** Don't try to fix it — switch to polling. This is what every production Slack tool does.
2. **Rate limiting is the #1 issue with polling.** 112 channels × `conversations.history` = instant rate limit. Scope filtering + max channels per cycle is the fix.
3. **Content hash dedup is critical.** Same commitment extracted from slightly different text (repeated messages, message edits) needs semantic dedup, not just message ID dedup.
4. **`INSERT OR IGNORE` prevents crashes.** The old `INSERT` would throw on duplicates and kill the adapter. Always use `OR IGNORE` for ingestion.
5. **First-run scans 24h only.** `oldest: '0'` on 112 channels = disaster. Default to 24h lookback for first run.
6. **Slack SDK auto-retries silently.** Rate limit retries don't show in your logs — the SDK handles them internally with 10s backoff. Your poll loop appears "stuck" but it's actually retrying.
7. **The `updated` field on Slack channels** lets you sort by activity. Poll active channels first.
8. **TeamAI Slack workspace**: enterprise_id `E064FALUXSL`, team_id `T064FAB0E1Z`, user `moiz` (`U05EHJ53C6P`). Samad = `U06HFDHBDB5` (DM: `D0640TA7ZST`), Jawad = `U06HJ0V7KHS` (DM: `D0729RMHUN7`).

## File Paths Quick Reference

### Pact CLI
- Repo: `~/Documents/Code/pact/`
- Source: `~/Documents/Code/pact/src/`
- Adapter: `~/Documents/Code/pact/src/adapters/slack.ts`
- Scope: `~/Documents/Code/pact/src/scope.ts`
- DB: `~/.pact/commitments.db`
- State: `~/.pact/slack-poll-state.json`
- Lock: `~/.pact/ingest.lock`
- Env: `~/Documents/Code/pact/.env`
- Docs: `~/Documents/Code/pact/docs/`

### Research (in life-os)
- Research folder: `~/Documents/Code/life-os/content/research/pact/`
- Blueprints: `blueprint-phase1.md`, `blueprint-phase3-5.md`
- Build plan: `09-build-plan.md`
- Adapters spec: `05-adapters.md`

### Reference Projects
- `/tmp/reference-projects/slackdump/` — Go Slack archiver
- `/tmp/reference-projects/slunk-mcp/` — Swift Slack scraper with content hash dedup

## How to Start Next Session

### Option 1: Commit scope filtering and test
```
I'm continuing the Pact CLI build. Read /Users/moiz/Documents/Code/pact/docs/research/tmp/session-handoff-pact-build-1.md for full context. Scope filtering is implemented but uncommitted. Commit it, then test: PACT_SCOPE_CHANNELS=teamai-product PACT_SCOPE_PEOPLE=samad,jawad pact ingest --slack. Also update docs/slack-setup.md with scope documentation.
```

### Option 2: Fix name matching and polish
```
I'm continuing the Pact CLI build. Read /Users/moiz/Documents/Code/pact/docs/research/tmp/session-handoff-pact-build-1.md for context. The scope filtering uses exact name match for people — "samad" needs to match "Abdul Samad". Fix listUsers() to support partial/fuzzy name matching. Then test end-to-end with a fresh DB.
```

### Option 3: Set up MCP server and create GitHub repo
```
I'm continuing the Pact CLI build. Read /Users/moiz/Documents/Code/pact/docs/research/tmp/session-handoff-pact-build-1.md for context. Two things: (1) Set up the MCP server in my Claude Code settings so I can query commitments from any project. (2) Create the GitHub repo at progrmoiz/pact and push.
```
