import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from './db.js';
import { listCommitments, getCommitmentById } from './queries.js';
import { insertCommitment, resolveCommitment } from './mutations.js';
import { extractCommitments } from './extract.js';
import { getAllOpenLoops, dismissOpenLoop, upsertOpenLoops, purgeStaleLoops } from './open-loops.js';
import { now } from './utils.js';

export async function startMcpServer(): Promise<void> {
  // Initialize DB
  getDb();

  const server = new Server(
    { name: 'pact', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'pact_list',
        description: 'List commitments with optional filters',
        inputSchema: {
          type: 'object' as const,
          properties: {
            status: { type: 'string', enum: ['active', 'done', 'cancelled'], description: 'Filter by status' },
            who: { type: 'string', description: 'Filter by person name' },
            overdue: { type: 'boolean', description: 'Show only overdue commitments' },
            source: { type: 'string', description: 'Filter by source platform' },
            limit: { type: 'number', description: 'Max results (default 50)' },
          },
        },
      },
      {
        name: 'pact_get',
        description: 'Get a single commitment by ID (supports partial ID)',
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Commitment ID or partial ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'pact_resolve',
        description: 'Mark a commitment as done or cancelled',
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Commitment ID' },
            status: { type: 'string', enum: ['done', 'cancelled'], description: 'Resolution status (default: done)' },
            note: { type: 'string', description: 'Optional resolution note' },
          },
          required: ['id'],
        },
      },
      {
        name: 'pact_extract',
        description: 'Extract commitments from text using LLM',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'Text to extract commitments from' },
            source: { type: 'string', description: 'Source platform label' },
            channel: { type: 'string', description: 'Source channel label' },
          },
          required: ['text'],
        },
      },
      {
        name: 'pact_open',
        description: 'Show all open loops — unreplied DMs, pending PR reviews, overdue commitments, ranked by urgency',
        inputSchema: {
          type: 'object' as const,
          properties: {
            type: { type: 'string', description: 'Filter by type (e.g., slack.dm, github.pr-review, commitment)' },
            source: { type: 'string', description: 'Filter by platform (e.g., slack, github)' },
            limit: { type: 'number', description: 'Max results (default 20)' },
          },
        },
      },
      {
        name: 'pact_dismiss',
        description: 'Dismiss an open loop by its source_ref',
        inputSchema: {
          type: 'object' as const,
          properties: {
            source_ref: { type: 'string', description: 'The source_ref of the open loop to dismiss' },
          },
          required: ['source_ref'],
        },
      },
      {
        name: 'pact_add',
        description: 'Add a commitment directly without LLM extraction',
        inputSchema: {
          type: 'object' as const,
          properties: {
            what: { type: 'string', description: 'What was committed to' },
            to: { type: 'string', description: 'Who is waiting on this' },
            deadline: { type: 'string', description: 'Deadline (ISO date or relative like "2h", "3d")' },
          },
          required: ['what'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'pact_list': {
          const results = listCommitments({
            status: args?.status as string | undefined,
            who: args?.who as string | undefined,
            overdue: args?.overdue as boolean | undefined,
            source: args?.source as string | undefined,
            limit: args?.limit as number | undefined,
          });
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }

        case 'pact_get': {
          const result = getCommitmentById(args?.id as string);
          if (!result) {
            return { isError: true, content: [{ type: 'text', text: `Commitment not found: ${args?.id}` }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'pact_resolve': {
          const status = (args?.status as 'done' | 'cancelled') || 'done';
          const result = resolveCommitment(args?.id as string, status, args?.note as string | undefined);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'pact_extract': {
          const results = await extractCommitments(args?.text as string);
          const stored = results.map(r =>
            insertCommitment({
              who: r.who,
              to_whom: r.to_whom,
              what: r.what,
              raw_text: args?.text as string,
              deadline: r.deadline,
              confidence: r.confidence,
              source_platform: (args?.source as string) || 'mcp',
              source_channel: args?.channel as string | undefined,
            })
          ).filter(c => c !== null);
          return { content: [{ type: 'text', text: JSON.stringify(stored, null, 2) }] };
        }

        case 'pact_open': {
          const loops = getAllOpenLoops({
            type: args?.type as string | undefined,
            source: args?.source as string | undefined,
            limit: (args?.limit as number) || 20,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ open_loops: loops, summary: { total: loops.length, critical: loops.filter(l => l.urgency >= 0.8).length } }, null, 2) }] };
        }

        case 'pact_dismiss': {
          const dismissed = dismissOpenLoop(args?.source_ref as string);
          return { content: [{ type: 'text', text: JSON.stringify({ dismissed, source_ref: args?.source_ref }) }] };
        }

        case 'pact_add': {
          const whoami = getDb().prepare("SELECT value FROM config WHERE key = 'whoami'").get() as { value: string } | undefined;
          const result = insertCommitment({
            who: whoami?.value || 'me',
            to_whom: (args?.to as string) || null,
            what: args?.what as string,
            raw_text: args?.what as string,
            deadline: (args?.deadline as string) || null,
            confidence: 1.0,
            source_platform: 'mcp',
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
