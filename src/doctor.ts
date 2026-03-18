import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDbPath, getWhoami, getPromptPath } from './utils.js';
import { getDb } from './db.js';
import { getTotalCount, getOverdueCount } from './queries.js';
import { loadScope } from './scope.js';
import { detectSlackTokens } from './adapters/slack/types.js';

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

  // Scope
  const scope = loadScope();
  if (scope) {
    const parts: string[] = [];
    if (scope.places.length) parts.push(`${scope.places.length} channel(s)`);
    if (scope.people.length) parts.push(`${scope.people.length} person(s)`);
    checks.push({ name: 'Scope', status: 'ok', detail: parts.join(', ') });
  } else {
    checks.push({
      name: 'Scope',
      status: 'warn',
      detail: 'Not set. Will poll ALL channels. Set PACT_SCOPE_CHANNELS or PACT_SCOPE_PEOPLE',
    });
  }

  // Slack tokens
  const slackTokens = detectSlackTokens();
  if (slackTokens) {
    if (slackTokens.mode === 'team') {
      checks.push({ name: 'Slack', status: 'ok', detail: `Team mode (bot token + app token → Socket Mode events)` });
    } else {
      checks.push({ name: 'Slack', status: 'ok', detail: `Solo mode (user token → polling)` });
    }
  } else {
    checks.push({ name: 'Slack', status: 'warn', detail: 'No Slack tokens. Set PACT_SLACK_USER_TOKEN (solo) or PACT_SLACK_BOT_TOKEN + PACT_SLACK_APP_TOKEN (team)' });
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
