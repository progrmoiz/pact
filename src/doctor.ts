import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDbPath, getWhoami, getPromptPath } from './utils.js';
import { getDb } from './db.js';
import { getTotalCount, getOverdueCount } from './queries.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function runDoctor(): Check[] {
  const checks: Check[] = [];

  // DB check
  try {
    const dbPath = getDbPath();
    getDb();
    const total = getTotalCount();
    const overdue = getOverdueCount();
    checks.push({
      name: 'Database',
      status: 'ok',
      detail: `${dbPath} (${total} commitments, ${overdue} overdue)`,
    });
  } catch (err) {
    checks.push({
      name: 'Database',
      status: 'fail',
      detail: `Cannot open database: ${(err as Error).message}`,
    });
  }

  // LLM API key
  const apiKey = process.env.PACT_LLM_API_KEY;
  if (apiKey) {
    const model = process.env.PACT_LLM_MODEL || 'claude-haiku-4-5-20251001';
    checks.push({
      name: 'LLM API Key',
      status: 'ok',
      detail: `Set (model: ${model})`,
    });
  } else {
    checks.push({
      name: 'LLM API Key',
      status: 'fail',
      detail: 'PACT_LLM_API_KEY not set',
    });
  }

  // Prompt file
  const promptPath = getPromptPath();
  if (existsSync(promptPath)) {
    checks.push({ name: 'Prompt file', status: 'ok', detail: promptPath });
  } else {
    checks.push({ name: 'Prompt file', status: 'fail', detail: `Not found: ${promptPath}` });
  }

  // Whoami
  const whoami = getWhoami();
  if (whoami) {
    checks.push({ name: 'Identity', status: 'ok', detail: whoami });
  } else {
    checks.push({
      name: 'Identity',
      status: 'warn',
      detail: 'Not set. Run: pact whoami <name> or set PACT_USER',
    });
  }

  // Agent detection
  const agents: string[] = [];
  const home = process.env.HOME || '~';
  if (existsSync(join(home, '.claude'))) agents.push('Claude Code');
  if (existsSync(join(home, '.cursor'))) agents.push('Cursor');
  if (existsSync(join(home, '.gemini'))) agents.push('Gemini CLI');

  if (agents.length > 0) {
    checks.push({ name: 'AI Agents', status: 'ok', detail: agents.join(', ') });
  } else {
    checks.push({ name: 'AI Agents', status: 'warn', detail: 'No agents detected' });
  }

  return checks;
}

export function formatDoctorOutput(checks: Check[]): string {
  const lines: string[] = [chalk.bold('\npact doctor\n')];

  for (const check of checks) {
    const icon = check.status === 'ok'
      ? chalk.green('✓')
      : check.status === 'warn'
        ? chalk.yellow('⚠')
        : chalk.red('✗');

    lines.push(`  ${icon} ${chalk.bold(check.name)}: ${check.detail}`);
  }

  const failures = checks.filter(c => c.status === 'fail');
  if (failures.length > 0) {
    lines.push(`\n${chalk.red(`${failures.length} issue(s) found.`)}`);
  } else {
    lines.push(`\n${chalk.green('All checks passed.')}`);
  }

  return lines.join('\n');
}
