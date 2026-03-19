import chalk from 'chalk';
import Table from 'cli-table3';
import type { Commitment, OpenLoop } from './types.js';

function shortId(id: string): string {
  return id.substring(0, 8);
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays > 0) return `in ${diffDays}d`;
  return `${Math.abs(diffDays)}d ago`;
}

function isOverdue(commitment: Commitment): boolean {
  if (commitment.status !== 'active' || !commitment.deadline) return false;
  return new Date(commitment.deadline) < new Date();
}

export function formatCommitmentTable(commitments: Commitment[]): string {
  if (commitments.length === 0) return chalk.dim('No commitments found.');

  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Who'),
      chalk.bold('What'),
      chalk.bold('Deadline'),
      chalk.bold('Status'),
      chalk.bold('Source'),
    ],
    colWidths: [10, 12, 40, 14, 10, 10],
    wordWrap: true,
  });

  for (const c of commitments) {
    const overdue = isOverdue(c);
    const deadlineStr = c.deadline
      ? (overdue ? chalk.red(relativeTime(c.deadline)) : chalk.green(relativeTime(c.deadline)))
      : chalk.dim('none');

    const statusStr = c.status === 'active'
      ? (overdue ? chalk.red('active') : chalk.green('active'))
      : c.status === 'done'
        ? chalk.dim('done')
        : chalk.yellow('cancelled');

    table.push([
      chalk.cyan(shortId(c.id)),
      c.who_name || '?',
      overdue ? chalk.red(c.what) : c.what,
      deadlineStr,
      statusStr,
      chalk.dim(c.source_platform),
    ]);
  }

  return table.toString();
}

export function formatExtractResult(commitments: Commitment[], dryRun: boolean): string {
  if (commitments.length === 0) return chalk.dim('0 commitments extracted.');

  const lines: string[] = [];
  const prefix = dryRun ? chalk.yellow('[DRY RUN] ') : '';

  for (const c of commitments) {
    const marker = dryRun ? chalk.yellow('○') : chalk.green('✓');
    lines.push(`${marker} ${prefix}${chalk.bold(c.what)}`);
    lines.push(`  Who: ${c.who_name || '?'} | Confidence: ${(c.confidence * 100).toFixed(0)}%`);
    if (c.deadline) lines.push(`  Deadline: ${relativeTime(c.deadline)} (${c.deadline.split('T')[0]})`);
    if (c.to_whom_name) lines.push(`  To: ${c.to_whom_name}`);
    lines.push('');
  }

  lines.push(`${commitments.length} commitment${commitments.length > 1 ? 's' : ''} ${dryRun ? 'found' : 'extracted'}.`);
  return lines.join('\n');
}

export function formatResolveResult(commitment: Commitment): string {
  const status = commitment.status === 'done' ? chalk.green('done') : chalk.yellow('cancelled');
  return `${chalk.green('✓')} ${chalk.bold(commitment.what)} → ${status}${
    commitment.resolution_note ? ` (${commitment.resolution_note})` : ''
  }`;
}

export function formatSnoozeResult(commitment: Commitment): string {
  return `${chalk.blue('⏰')} ${chalk.bold(commitment.what)} → snoozed to ${
    commitment.deadline ? relativeTime(commitment.deadline) + ` (${commitment.deadline.split('T')[0]})` : '?'
  }`;
}

function urgencyDots(urgency: number): string {
  const filled = Math.round(urgency * 5);
  const dots = '●'.repeat(filled) + '○'.repeat(5 - filled);
  if (urgency >= 0.8) return chalk.red(dots);
  if (urgency >= 0.5) return chalk.yellow(dots);
  return chalk.dim(dots);
}

function formatAge(detectedAt: string): string {
  const ms = Date.now() - new Date(detectedAt).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.floor(ms / 60000)}m`;
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function typeLabel(type: string): string {
  // Pad to consistent width for alignment
  return type.padEnd(20);
}

export function formatOpenLoops(loops: OpenLoop[]): string {
  if (loops.length === 0) return chalk.dim('No open loops. You\'re all caught up.');

  const lines: string[] = [];
  lines.push('');

  for (const loop of loops) {
    const dots = urgencyDots(loop.urgency);
    const type = chalk.cyan(typeLabel(loop.type));
    const title = loop.urgency >= 0.8 ? chalk.red(loop.title) : loop.title;
    const age = chalk.dim(formatAge(loop.detected_at).padStart(6));
    const who = loop.who_waiting ? chalk.dim(loop.who_waiting) : '';

    lines.push(`  ${dots}  ${type} ${title.padEnd(40)} ${age}  ${who}`);
  }

  const critical = loops.filter(l => l.urgency >= 0.8).length;
  lines.push('');
  lines.push(`  ${loops.length} open loop${loops.length !== 1 ? 's' : ''}.${critical > 0 ? chalk.red(` ${critical} critical.`) : ''}`);
  lines.push('');

  return lines.join('\n');
}
