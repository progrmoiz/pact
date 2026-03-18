# pact

Track every promise you make. From the terminal.

```bash
$ echo "I'll send the deck to Sarah by Friday" | pact extract
✓ Send the deck to Sarah
  Who: Moiz | Confidence: 95%
  Deadline: in 3d (2026-03-21)

1 commitment extracted.
```

## Install

```bash
git clone https://github.com/progrmoiz/pact.git
cd pact
npm install
npm run build
npm install -g .
```

## Setup

```bash
# Set your Anthropic API key
export PACT_LLM_API_KEY=sk-ant-...

# Set your identity
pact whoami "Moiz"

# Check everything works
pact doctor
```

## Usage

### Extract commitments

Pipe any text — meeting notes, messages, journal entries:

```bash
echo "I'll review the PR by tomorrow and send the report to Sarah by Friday" | pact extract
```

### List commitments

```bash
pact list                 # all active
pact list --overdue       # past deadline
pact list --who "Moiz"    # by person
pact list --status done   # completed
pact list --json          # machine-readable
```

### Resolve

```bash
pact resolve 01HXK --note "Shipped it"
pact resolve 01HXK --cancel
```

### Snooze

```bash
pact snooze 01HXK --days 3
pact snooze 01HXK --until friday
```

### Other commands

```bash
pact whoami              # show current identity
pact schema commitment   # JSON schema for agents
pact doctor              # diagnostics
```

### Slack (live monitoring)

Connect to Slack and track commitments from conversations automatically — no tagging, no commands. Solo mode uses your own token so no one knows it's running.

```bash
pact ingest --slack
```

See [docs/slack-setup.md](docs/slack-setup.md) for full setup guide.

### Follow-up nudges

```bash
pact follow-up --dry-run          # preview overdue
pact follow-up --via stdout       # terminal nudges
pact follow-up --via slack-dm     # DM nudges with buttons
```

### MCP server (for AI agents)

Let Claude Code, Cursor, or Windsurf query your commitments directly.

```bash
pact serve --mcp
```

See [docs/mcp-setup.md](docs/mcp-setup.md) for configuration.

## How it works

1. Text goes in — via stdin, Slack, or MCP
2. Pre-filter catches commitment signals (17 regex patterns, drops 97-99% of noise)
3. LLM extracts commitments (who, what, to whom, deadline, confidence)
4. Results stored in local SQLite (`~/.pact/commitments.db`)
5. Query, resolve, snooze from the terminal or via MCP tools
6. Follow-up engine nudges overdue items via terminal or Slack DM

## All commands

| Command | Description |
|---------|-------------|
| `pact extract` | Extract commitments from piped text |
| `pact list` | List commitments with filters |
| `pact resolve <id>` | Mark done or cancelled |
| `pact snooze <id>` | Reschedule deadline |
| `pact ingest --slack` | Live Slack monitoring |
| `pact follow-up` | Nudge overdue commitments |
| `pact serve --mcp` | MCP server for AI agents |
| `pact whoami [name]` | Set or show identity |
| `pact schema <type>` | JSON schema for agents |
| `pact doctor` | Run diagnostics |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PACT_LLM_API_KEY` | Yes | — | Anthropic API key |
| `PACT_LLM_MODEL` | No | `claude-haiku-4-5-20251001` | Model to use |
| `PACT_USER` | No | — | Your name (alternative to `pact whoami`) |
| `PACT_DB_PATH` | No | `~/.pact/commitments.db` | Database path |
| `PACT_SLACK_BOT_TOKEN` | For Slack | — | Slack user or bot token |
| `PACT_SLACK_APP_TOKEN` | For Slack | — | Slack app-level token (Socket Mode) |

## License

MIT
