import chalk from 'chalk';
import Table from 'cli-table3';
import type { Commitment } from './types.js';

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
