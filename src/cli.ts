import { Command } from 'commander';
import { isInteractive, parseRelativeDate } from './utils.js';
import { getDb } from './db.js';
import { extractCommitments } from './extract.js';
import { insertCommitment, resolveCommitment, snoozeCommitment, setWhoami } from './mutations.js';
import { listCommitments, getCommitmentById, getOverdueCount, getAllCommitmentIds } from './queries.js';
import { formatCommitmentTable, formatExtractResult, formatResolveResult, formatSnoozeResult } from './format.js';
import { commitmentSchema, identitySchema } from './schemas.js';
import { runDoctor, formatDoctorOutput } from './doctor.js';
import { getWhoami, resolvePartialId } from './utils.js';

const program = new Command();

program
  .name('pact')
  .description('Track every promise you make. From the terminal.')
  .version('0.1.0');

// extract
program
  .command('extract')
  .description('Extract commitments from piped text')
  .option('--source <platform>', 'Source platform', 'stdin')
  .option('--channel <name>', 'Source channel')
  .option('--dry-run', 'Preview without storing')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const useJson = opts.json || !isInteractive();

    // Read all stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf-8').trim();

    if (!text) {
      if (useJson) {
        console.log(JSON.stringify({ commitments: [], count: 0 }));
      } else {
        console.log('No input received. Pipe text to extract commitments.');
      }
      process.exit(0);
    }

    // Initialize DB
    getDb();

    const results = await extractCommitments(text);

    if (opts.dryRun) {
      const dryCommitments = results.map(r => ({
        id: '(dry-run)',
        who_id: '',
        who_name: r.who || getWhoami() || '?',
        to_whom_id: null,
        to_whom_name: r.to_whom || undefined,
        what: r.what,
        raw_text: text,
        deadline: r.deadline,
        confidence: r.confidence,
        status: 'active' as const,
        source_platform: opts.source,
        source_channel: opts.channel || null,
        source_message_id: null,
        source_url: null,
        resolved_at: null,
        resolution_note: null,
        nudge_count: 0,
        last_nudged_at: null,
        escalated: 0,
        escalated_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      if (useJson) {
        console.log(JSON.stringify({ commitments: dryCommitments, count: dryCommitments.length }));
      } else {
        console.log(formatExtractResult(dryCommitments, true));
      }
      process.exit(0);
    }

    const stored = results.map(r =>
      insertCommitment({
        who: r.who,
        to_whom: r.to_whom,
        what: r.what,
        raw_text: text,
        deadline: r.deadline,
        confidence: r.confidence,
        source_platform: opts.source,
        source_channel: opts.channel,
      })
    );

    if (useJson) {
      console.log(JSON.stringify({ commitments: stored, count: stored.length }));
    } else {
      console.log(formatExtractResult(stored, false));
    }
  });

// list
program
  .command('list')
  .description('List commitments')
  .option('--overdue', 'Show only overdue')
  .option('--who <name>', 'Filter by person')
  .option('--status <status>', 'Filter by status (active, done, cancelled)')
  .option('--source <platform>', 'Filter by source platform')
  .option('--due-before <date>', 'Due before date')
  .option('--due-after <date>', 'Due after date')
  .option('--limit <n>', 'Max results', '50')
  .option('--json', 'JSON output')
  .action((opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const commitments = listCommitments({
      overdue: opts.overdue,
      who: opts.who,
      status: opts.status,
      source: opts.source,
      dueBefore: opts.dueBefore,
      dueAfter: opts.dueAfter,
      limit: parseInt(opts.limit),
    });

    if (useJson) {
      console.log(JSON.stringify(commitments));
    } else {
      console.log(formatCommitmentTable(commitments));
      const overdue = getOverdueCount();
      console.log(`\n${commitments.length} commitment(s)${overdue > 0 ? ` (${overdue} overdue)` : ''}`);
    }
  });

// resolve
program
  .command('resolve <id>')
  .description('Mark a commitment as done or cancelled')
  .option('--cancel', 'Cancel instead of marking done')
  .option('--note <text>', 'Resolution note')
  .option('--json', 'JSON output')
  .action((id, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    // Resolve partial ID
    const allIds = getAllCommitmentIds();
    const fullId = resolvePartialId(allIds, id) || id;

    try {
      const status = opts.cancel ? 'cancelled' as const : 'done' as const;
      const result = resolveCommitment(fullId, status, opts.note);

      if (useJson) {
        console.log(JSON.stringify(result));
      } else {
        console.log(formatResolveResult(result));
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// snooze
program
  .command('snooze <id>')
  .description('Reschedule a commitment deadline')
  .option('--until <date>', 'New deadline (ISO date or relative: tomorrow, friday, +3d)')
  .option('--days <n>', 'Push deadline by N days')
  .option('--json', 'JSON output')
  .action((id, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    if (!opts.until && !opts.days) {
      console.error('Specify --until <date> or --days <n>');
      process.exit(1);
    }

    let newDeadline: string;
    if (opts.days) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(opts.days));
      d.setHours(17, 0, 0, 0);
      newDeadline = d.toISOString();
    } else {
      const parsed = parseRelativeDate(opts.until);
      if (!parsed) {
        console.error(`Cannot parse date: ${opts.until}`);
        process.exit(1);
      }
      newDeadline = parsed;
    }

    const allIds = getAllCommitmentIds();
    const fullId = resolvePartialId(allIds, id) || id;

    try {
      const result = snoozeCommitment(fullId, newDeadline);
      if (useJson) {
        console.log(JSON.stringify(result));
      } else {
        console.log(formatSnoozeResult(result));
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// schema
program
  .command('schema <type>')
  .description('Dump JSON schema for commitment or identity')
  .action((type) => {
    if (type === 'commitment') {
      console.log(JSON.stringify(commitmentSchema, null, 2));
    } else if (type === 'identity') {
      console.log(JSON.stringify(identitySchema, null, 2));
    } else {
      console.error(`Unknown schema type: ${type}. Use: commitment, identity`);
      process.exit(1);
    }
  });

// doctor
program
  .command('doctor')
  .description('Run diagnostics')
  .action(() => {
    const checks = runDoctor();
    console.log(formatDoctorOutput(checks));
    const failures = checks.filter(c => c.status === 'fail');
    process.exit(failures.length > 0 ? 1 : 0);
  });

// whoami
program
  .command('whoami [name]')
  .description('Set or show local identity')
  .action((name) => {
    if (name) {
      getDb();
      const identity = setWhoami(name);
      console.log(`Identity set: ${identity.display_name} (${identity.id.substring(0, 8)})`);
    } else {
      const current = getWhoami();
      if (current) {
        console.log(current);
      } else {
        console.log('Not set. Run: pact whoami <name> or set PACT_USER');
      }
    }
  });

// ingest (Phase 3)
program
  .command('ingest')
  .description('Start live platform monitoring')
  .option('--slack', 'Connect to Slack via Socket Mode')
  .action(async (opts) => {
    if (!opts.slack) {
      console.error('Specify an adapter: --slack');
      process.exit(1);
    }
    if (opts.slack) {
      const { startSlackAdapter } = await import('./adapters/slack.js');
      await startSlackAdapter();
    }
  });

// follow-up (Phase 4)
program
  .command('follow-up')
  .description('Send nudges for overdue commitments')
  .option('--via <channel>', 'Output channel: stdout, slack-dm', 'stdout')
  .option('--dry-run', 'Preview without sending')
  .option('--grace-period <duration>', 'Grace period after deadline', '4h')
  .option('--max-nudges <n>', 'Max nudges before escalation', '3')
  .option('--cooldown <duration>', 'Time between nudges', '24h')
  .option('--escalate-after <n>', 'Escalate after N nudges')
  .option('--escalate-to <target>', 'Escalation target')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const { runFollowUp } = await import('./follow-up.js');
    const result = await runFollowUp({
      via: opts.via as 'stdout' | 'slack-dm',
      gracePeriod: opts.gracePeriod,
      maxNudges: parseInt(opts.maxNudges),
      cooldown: opts.cooldown,
      escalateAfter: opts.escalateAfter ? parseInt(opts.escalateAfter) : undefined,
      escalateTo: opts.escalateTo,
      dryRun: !!opts.dryRun,
    });

    if (useJson) {
      console.log(JSON.stringify(result));
    } else if (!opts.dryRun) {
      if (result.nudged === 0) {
        console.log('No overdue commitments to nudge.');
      } else {
        console.log(`\n${result.nudged} nudged, ${result.escalated} escalated.`);
      }
    }
  });

// serve (Phase 5)
program
  .command('serve')
  .description('Start Pact server')
  .option('--mcp', 'MCP server mode (stdio)')
  .action(async (opts) => {
    if (opts.mcp) {
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer();
    } else {
      console.error('Specify a mode: --mcp');
      process.exit(1);
    }
  });

program.parse();
