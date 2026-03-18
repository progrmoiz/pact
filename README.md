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

## How it works

1. Text goes in via stdin
2. LLM extracts commitments (who, what, to whom, deadline, confidence)
3. Results stored in local SQLite (`~/.pact/commitments.db`)
4. Query, resolve, snooze from the terminal
5. Non-TTY auto-detects and outputs JSON (pipe-friendly)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PACT_LLM_API_KEY` | Yes | — | Anthropic API key |
| `PACT_LLM_MODEL` | No | `claude-haiku-4-5-20251001` | Model to use |
| `PACT_USER` | No | — | Your name (alternative to `pact whoami`) |
| `PACT_DB_PATH` | No | `~/.pact/commitments.db` | Database path |

## License

MIT
