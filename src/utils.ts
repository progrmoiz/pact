import { ulid } from 'ulid';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export function genId(): string {
  return ulid();
}

export function now(): string {
  return new Date().toISOString();
}

export function isInteractive(): boolean {
  return !!process.stdout.isTTY;
}

export function getWhoami(): string | null {
  if (process.env.PACT_USER) return process.env.PACT_USER;
  const whoamiPath = join(getPactDir(), 'whoami');
  if (existsSync(whoamiPath)) {
    return readFileSync(whoamiPath, 'utf-8').trim() || null;
  }
  return null;
}

export function setWhoamiFile(name: string): void {
  const dir = getPactDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'whoami'), name, 'utf-8');
}

export function getPactDir(): string {
  return process.env.PACT_DB_DIR || join(process.env.HOME || '~', '.pact');
}

export function getDbPath(): string {
  return process.env.PACT_DB_PATH || join(getPactDir(), 'commitments.db');
}

export function getPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function getPromptPath(): string {
  return join(getPackageRoot(), 'prompts', 'extract.md');
}

export function resolvePartialId(ids: string[], partialId: string): string | null {
  const matches = ids.filter(id => id.startsWith(partialId.toUpperCase()));
  if (matches.length === 1) return matches[0];
  return null;
}

export function parseRelativeDate(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // ISO date passthrough
  if (/^\d{4}-\d{2}-\d{2}/.test(lower)) {
    return new Date(input).toISOString();
  }

  // +Nd, +Nw
  const relMatch = lower.match(/^\+(\d+)([dwh])$/);
  if (relMatch) {
    const [, n, unit] = relMatch;
    const d = new Date();
    if (unit === 'd') d.setDate(d.getDate() + parseInt(n));
    else if (unit === 'w') d.setDate(d.getDate() + parseInt(n) * 7);
    else if (unit === 'h') d.setHours(d.getHours() + parseInt(n));
    return d.toISOString();
  }

  // "tomorrow"
  if (lower === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(17, 0, 0, 0);
    return d.toISOString();
  }

  // "today", "eod"
  if (lower === 'today' || lower === 'eod') {
    const d = new Date();
    d.setHours(17, 0, 0, 0);
    return d.toISOString();
  }

  // Day names
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextMatch = lower.match(/^(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextMatch) {
    const target = days.indexOf(nextMatch[1]);
    const d = new Date();
    const current = d.getDay();
    let diff = target - current;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    d.setHours(17, 0, 0, 0);
    return d.toISOString();
  }

  return null;
}

export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${str}. Use format: 0s, 30m, 4h, 1d`);
  const [, n, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(n) * multipliers[unit];
}
