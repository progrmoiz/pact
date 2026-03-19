import { Command } from 'commander';
import chalk from 'chalk';
import type { Commitment } from './types.js';
import { isInteractive, parseRelativeDate } from './utils.js';
import { getDb } from './db.js';
import { extractCommitments } from './extract.js';
import { insertCommitment, resolveCommitment, snoozeCommitment, setWhoami, mergeIdentities, listIdentities, editCommitment } from './mutations.js';
import { listCommitments, getCommitmentById, getOverdueCount, getAllCommitmentIds } from './queries.js';
import { formatCommitmentTable, formatExtractResult, formatResolveResult, formatSnoozeResult } from './format.js';
import { commitmentSchema, identitySchema } from './schemas.js';
import { runDoctor, formatDoctorOutput } from './doctor.js';
import { getWhoami, resolvePartialId } from './utils.js';
import { getPersonStats, formatStats, formatPersonDetail, getDigest, formatDigest } from './stats.js';
import { getAllOpenLoops, dismissOpenLoop } from './open-loops.js';
import { formatOpenLoops } from './format.js';

const program = new Command();

program
  .name('pact')
  .description('Never drop the ball.')
  .version('0.2.0');

// open (THE command — all open loops ranked by urgency)
program
  .command('open')
  .description('Show all open loops — everything you\'re dropping')
  .option('--type <type>', 'Filter by type (e.g., slack.dm, commitment, github.pr-review)')
  .option('--source <platform>', 'Filter by platform (e.g., slack, github)')
  .option('--limit <n>', 'Max results', '20')
  .option('--json', 'JSON output')
  .action((opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const loops = getAllOpenLoops({
      type: opts.type,
      source: opts.source,
      limit: parseInt(opts.limit),
    });

    if (useJson) {
      console.log(JSON.stringify({
        open_loops: loops,
        summary: {
          total: loops.length,
          critical: loops.filter(l => l.urgency >= 0.8).length,
        },
      }, null, 2));
    } else {
      console.log(formatOpenLoops(loops));
    }
  });

// dismiss (mark an open loop as not needing action)
program
  .command('dismiss <source-ref>')
  .description('Dismiss an open loop')
  .option('--json', 'JSON output')
  .action((sourceRef, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const result = dismissOpenLoop(sourceRef);
    if (useJson) {
      console.log(JSON.stringify({ dismissed: result, source_ref: sourceRef }));
    } else if (result) {
      console.log(`${chalk.green('✓')} Dismissed: ${sourceRef}`);
    } else {
      console.error(`Not found: ${sourceRef}`);
      process.exit(1);
    }
  });

// scan (run open loop scanners)
program
  .command('scan')
  .description('Scan platforms for open loops')
  .option('--slack', 'Scan Slack for unreplied DMs and mentions')
  .option('--github', 'Scan GitHub for PR reviews and assigned issues')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    if (!opts.slack && !opts.github) {
      // Auto-detect: scan all configured platforms
      opts.slack = !!(process.env.PACT_SLACK_USER_TOKEN || process.env.PACT_SLACK_BOT_TOKEN);
      opts.github = !!process.env.PACT_GITHUB_TOKEN;

      if (!opts.slack && !opts.github) {
        console.error('No platforms configured. Set PACT_SLACK_USER_TOKEN or PACT_GITHUB_TOKEN.');
        process.exit(1);
      }
    }

    const { upsertOpenLoops, purgeStaleLoops } = await import('./open-loops.js');
    const { now } = await import('./utils.js');
    const scanTimestamp = now();
    const results: { platform: string; found: number; purged: number }[] = [];

    if (opts.slack) {
      const token = process.env.PACT_SLACK_USER_TOKEN || process.env.PACT_SLACK_BOT_TOKEN;
      if (!token) {
        console.error('Slack scan requires PACT_SLACK_USER_TOKEN or PACT_SLACK_BOT_TOKEN');
        process.exit(1);
      }

      const { SlackScanner } = await import('./adapters/slack/scanner.js');
      const scanner = new SlackScanner(token);

      if (!useJson) process.stdout.write('Scanning Slack...');
      const loops = await scanner.scan();

      // Recompute urgency for each loop (in case thresholds changed)
      const { upserted } = upsertOpenLoops(loops);
      const purged = purgeStaleLoops('slack', scanTimestamp);

      results.push({ platform: 'slack', found: loops.length, purged });
      if (!useJson) console.log(` ${loops.length} open loop${loops.length !== 1 ? 's' : ''} (${purged} resolved)`);
    }

    if (opts.github) {
      if (!process.env.PACT_GITHUB_TOKEN) {
        console.error('GitHub scan requires PACT_GITHUB_TOKEN');
        process.exit(1);
      }

      const { GitHubScanner } = await import('./adapters/github/scanner.js');
      const scanner = new GitHubScanner(process.env.PACT_GITHUB_TOKEN);

      if (!useJson) process.stdout.write('Scanning GitHub...');
      const loops = await scanner.scan();

      const { upserted } = upsertOpenLoops(loops);
      const purged = purgeStaleLoops('github', scanTimestamp);

      results.push({ platform: 'github', found: loops.length, purged });
      if (!useJson) console.log(` ${loops.length} open loop${loops.length !== 1 ? 's' : ''} (${purged} resolved)`);
    }

    if (useJson) {
      console.log(JSON.stringify({ scan: results }, null, 2));
    }
  });

// add (quick-add commitment without LLM)
program
  .command('add <text>')
  .description('Quick-add a commitment (no LLM extraction)')
  .option('--deadline <date>', 'Deadline (ISO date, or: tomorrow, friday, +3d)')
  .option('--to <name>', 'Who you promised this to')
  .option('--json', 'JSON output')
  .action((text, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    let deadline: string | null = null;
    if (opts.deadline) {
      deadline = parseRelativeDate(opts.deadline);
      if (!deadline) {
        console.error(`Cannot parse date: ${opts.deadline}`);
        process.exit(1);
      }
    }

    const commitment = insertCommitment({
      who: getWhoami(),
      to_whom: opts.to || null,
      what: text,
      raw_text: text,
      deadline,
      confidence: 1.0,
      source_platform: 'manual',
      source_channel: null,
    });

    if (!commitment) {
      console.error('Duplicate commitment — already exists.');
      process.exit(1);
    }

    if (useJson) {
      console.log(JSON.stringify(commitment, null, 2));
    } else {
      console.log(`${chalk.green('✓')} Added: ${chalk.bold(text)}`);
      if (deadline) console.log(`  Deadline: ${deadline}`);
      if (opts.to) console.log(`  To: ${opts.to}`);
    }
  });

// remind (future reminder — commitment with a deadline, no "who")
program
  .command('remind <text>')
  .description('Set a future reminder')
  .option('--in <duration>', 'When to remind (e.g., 3d, 4h, 1w)')
  .option('--on <date>', 'Specific date (ISO or relative: tomorrow, friday)')
  .option('--json', 'JSON output')
  .action((text, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    if (!opts.in && !opts.on) {
      console.error('Specify when: --in 3d or --on friday');
      process.exit(1);
    }

    let deadline: string;
    if (opts.in) {
      const match = opts.in.match(/^(\d+)(h|d|w)$/);
      if (!match) {
        console.error(`Cannot parse duration: ${opts.in}. Use: 3d, 4h, 1w`);
        process.exit(1);
      }
      const [, n, unit] = match;
      const ms = parseInt(n) * ({ h: 3600000, d: 86400000, w: 604800000 } as Record<string, number>)[unit];
      deadline = new Date(Date.now() + ms).toISOString();
    } else {
      const parsed = parseRelativeDate(opts.on);
      if (!parsed) {
        console.error(`Cannot parse date: ${opts.on}`);
        process.exit(1);
      }
      deadline = parsed;
    }

    const commitment = insertCommitment({
      who: getWhoami(),
      to_whom: null,
      what: text,
      raw_text: `Reminder: ${text}`,
      deadline,
      confidence: 1.0,
      source_platform: 'manual',
      source_channel: null,
    });

    if (!commitment) {
      console.error('Duplicate reminder — already exists.');
      process.exit(1);
    }

    if (useJson) {
      console.log(JSON.stringify(commitment, null, 2));
    } else {
      const d = new Date(deadline);
      console.log(`${chalk.blue('⏰')} Reminder set: ${chalk.bold(text)}`);
      console.log(`  When: ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`);
    }
  });

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
    ).filter((c): c is Commitment => c !== null);

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
  .option('--slack', 'Connect to Slack via polling')
  .action(async (opts) => {
    if (!opts.slack) {
      console.error('Specify an adapter: --slack');
      process.exit(1);
    }
    if (opts.slack) {
      const { startSlackAdapter } = await import('./adapters/slack/index.js');
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

// stats (Phase 6)
program
  .command('stats')
  .description('Accountability analytics per person')
  .option('--who <name>', 'Show detail for a specific person')
  .option('--json', 'JSON output')
  .action((opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const stats = getPersonStats(opts.who);

    if (useJson) {
      console.log(JSON.stringify(stats, null, 2));
    } else if (opts.who && stats.length === 1) {
      console.log(formatPersonDetail(stats[0]));
    } else {
      console.log(formatStats(stats));
    }
  });

// digest (Phase 6)
program
  .command('digest')
  .description('Summary report for a time period')
  .option('--period <period>', 'day, week, or month', 'week')
  .option('--json', 'JSON output')
  .action((opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    const period = opts.period as 'day' | 'week' | 'month';
    if (!['day', 'week', 'month'].includes(period)) {
      console.error('Period must be: day, week, or month');
      process.exit(1);
    }

    const data = getDigest(period);

    if (useJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatDigest(data));
    }
  });

// edit
program
  .command('edit <id>')
  .description('Edit a commitment')
  .option('--what <text>', 'Update the commitment text')
  .option('--deadline <date>', 'Update deadline (ISO date or relative: tomorrow, friday, +3d)')
  .option('--who <name>', 'Update who made the commitment')
  .option('--json', 'JSON output')
  .action((id, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    if (!opts.what && !opts.deadline && !opts.who) {
      console.error('Specify at least one field to edit: --what, --deadline, --who');
      process.exit(1);
    }

    const allIds = getAllCommitmentIds();
    const fullId = resolvePartialId(allIds, id) || id;

    const updates: Record<string, string> = {};
    if (opts.what) updates.what = opts.what;
    if (opts.deadline) {
      const parsed = parseRelativeDate(opts.deadline);
      if (!parsed) {
        console.error(`Cannot parse date: ${opts.deadline}`);
        process.exit(1);
      }
      updates.deadline = parsed;
    }

    try {
      const result = editCommitment(fullId, updates, opts.who);
      if (useJson) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`${chalk.green('✓')} Updated ${chalk.cyan(fullId.substring(0, 8))}`);
        if (opts.what) console.log(`  What: ${opts.what}`);
        if (opts.deadline) console.log(`  Deadline: ${updates.deadline}`);
        if (opts.who) console.log(`  Who: ${opts.who}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// identities
const identitiesCmd = program
  .command('identities')
  .description('Manage identities');

identitiesCmd
  .command('list')
  .description('List all identities and their aliases')
  .option('--json', 'JSON output')
  .action((opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();
    const identities = listIdentities();

    if (useJson) {
      console.log(JSON.stringify(identities, null, 2));
    } else {
      if (identities.length === 0) {
        console.log('No identities found.');
        return;
      }
      for (const i of identities) {
        const aliases = i.aliases.map(a => `${a.platform}:${a.handle}`).join(', ');
        console.log(`  ${i.id.substring(0, 8)}  ${i.display_name}  [${aliases}]`);
      }
      console.log(`\n${identities.length} identity(ies)`);
    }
  });

identitiesCmd
  .command('merge <keep-id> <merge-id>')
  .description('Merge two identities. Keeps first, absorbs second.')
  .option('--json', 'JSON output')
  .action((keepId, mergeId, opts) => {
    const useJson = opts.json || !isInteractive();
    getDb();

    // Resolve partial IDs against identity table
    const identities = listIdentities();
    const allIds = identities.map(i => i.id);
    const resolvedKeep = resolvePartialId(allIds, keepId) || keepId;
    const resolvedMerge = resolvePartialId(allIds, mergeId) || mergeId;

    try {
      const result = mergeIdentities(resolvedKeep, resolvedMerge);
      if (useJson) {
        console.log(JSON.stringify({ keep: resolvedKeep, absorbed: resolvedMerge, commitments_moved: result.merged, aliases_moved: result.aliases }));
      } else {
        console.log(`Merged ${resolvedMerge.substring(0, 8)} into ${resolvedKeep.substring(0, 8)}`);
        console.log(`  ${result.merged} commitment(s) moved, ${result.aliases} alias(es) absorbed`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
