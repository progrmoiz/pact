# MCP Server Setup

Pact includes an MCP (Model Context Protocol) server so AI agents like Claude Code, Cursor, and Windsurf can query and manage commitments directly.

## Setup

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "pact": {
      "command": "pact",
      "args": ["serve", "--mcp"],
      "env": {
        "PACT_LLM_API_KEY": "sk-ant-your-key"
      }
    }
  }
}
```

For Cursor, add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pact": {
      "command": "pact",
      "args": ["serve", "--mcp"],
      "env": {
        "PACT_LLM_API_KEY": "sk-ant-your-key"
      }
    }
  }
}
```

## Available tools

| Tool | Description | Example prompt |
|------|-------------|---------------|
| `pact_list` | List commitments with filters | "What commitments are overdue?" |
| `pact_get` | Get a single commitment by ID | "Show me commitment 01HXK" |
| `pact_resolve` | Mark done or cancelled | "Mark commitment 01HXK as done" |
| `pact_extract` | Extract commitments from text | "Extract commitments from this meeting note: ..." |

## How it works

The MCP server runs over stdio — the AI agent spawns `pact serve --mcp` as a subprocess and communicates via JSON-RPC over stdin/stdout. No HTTP, no ports, no network.

The server connects to the same local SQLite database (`~/.pact/commitments.db`) as the CLI. Everything stays local.

## Example interactions

Once configured, you can ask your AI agent:

- "What did I promise this week?"
- "Any overdue commitments?"
- "Mark the Selvo pricing page commitment as done"
- "Extract commitments from this Slack thread: [paste text]"

The agent will use the MCP tools automatically.
