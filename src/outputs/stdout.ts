import chalk from 'chalk';
import type { NudgeCandidate } from '../types.js';

export function sendStdoutNudge(candidate: NudgeCandidate, message: string): void {
  const daysOverdue = Math.ceil(
    (Date.now() - new Date(candidate.deadline).getTime()) / 86400000
  );

  console.log(
    `${chalk.red('!')} ${chalk.bold('OVERDUE')}: "${chalk.bold(candidate.what)}" ` +
    `(${candidate.who_name}, ${chalk.red(`${daysOverdue}d overdue`)}, nudge #${candidate.nudge_count + 1})`
  );
}
