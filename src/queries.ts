import { getDb } from './db.js';
import type { Commitment, ListFilters, NudgeCandidate } from './types.js';

export function listCommitments(filters: ListFilters = {}): Commitment[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status) {
    conditions.push('c.status = ?');
    params.push(filters.status);
  }

  if (filters.who) {
    conditions.push('i.display_name LIKE ?');
    params.push(`%${filters.who}%`);
  }

  if (filters.overdue) {
    conditions.push("c.status = 'active' AND c.deadline IS NOT NULL AND c.deadline < datetime('now')");
  }

  if (filters.source) {
    conditions.push('c.source_platform = ?');
    params.push(filters.source);
  }

  if (filters.channel) {
    conditions.push('c.source_channel = ?');
    params.push(filters.channel);
  }

  if (filters.dueBefore) {
    conditions.push('c.deadline <= ?');
    params.push(filters.dueBefore);
  }

  if (filters.dueAfter) {
    conditions.push('c.deadline >= ?');
    params.push(filters.dueAfter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;

  const query = `
    SELECT c.*, i.display_name as who_name,
           i2.display_name as to_whom_name
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    LEFT JOIN identities i2 ON c.to_whom_id = i2.id
    ${where}
    ORDER BY c.deadline ASC NULLS LAST, c.created_at DESC
    LIMIT ?
  `;

  return db.prepare(query).all(...params, limit) as Commitment[];
}

export function getCommitmentById(id: string): Commitment | null {
  const db = getDb();

  // Exact match first
  let result = db.prepare(`
    SELECT c.*, i.display_name as who_name,
           i2.display_name as to_whom_name
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    LEFT JOIN identities i2 ON c.to_whom_id = i2.id
    WHERE c.id = ?
  `).get(id) as Commitment | undefined;

  if (result) return result;

  // Partial ID match
  const matches = db.prepare(`
    SELECT c.*, i.display_name as who_name,
           i2.display_name as to_whom_name
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    LEFT JOIN identities i2 ON c.to_whom_id = i2.id
    WHERE c.id LIKE ? || '%'
  `).all(id.toUpperCase()) as Commitment[];

  if (matches.length === 1) return matches[0];
  return null;
}

export function getOverdueCount(): number {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM commitments
    WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')
  `).get() as { count: number };
  return result.count;
}

export function getTotalCount(status?: string): number {
  const db = getDb();
  if (status) {
    const result = db.prepare('SELECT COUNT(*) as count FROM commitments WHERE status = ?').get(status) as { count: number };
    return result.count;
  }
  const result = db.prepare('SELECT COUNT(*) as count FROM commitments').get() as { count: number };
  return result.count;
}

export function getAllCommitmentIds(): string[] {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM commitments').all() as { id: string }[];
  return rows.map(r => r.id);
}

export function getNudgeCandidates(
  graceMs: number,
  cooldownMs: number,
  maxNudges: number
): NudgeCandidate[] {
  const db = getDb();
  const graceSec = Math.floor(graceMs / 1000);
  const cooldownSec = Math.floor(cooldownMs / 1000);

  return db.prepare(`
    SELECT c.id, c.who_id, i.display_name as who_name,
           ia.handle as who_slack_id,
           c.what, c.deadline, c.nudge_count, c.last_nudged_at, c.escalated
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    LEFT JOIN identity_aliases ia ON i.id = ia.identity_id AND ia.platform = 'slack'
    WHERE c.status = 'active'
      AND c.deadline IS NOT NULL
      AND datetime(c.deadline, '+' || ? || ' seconds') < datetime('now')
      AND c.nudge_count < ?
      AND (c.last_nudged_at IS NULL
           OR datetime(c.last_nudged_at, '+' || ? || ' seconds') < datetime('now'))
      AND c.escalated = 0
    ORDER BY c.deadline ASC
  `).all(graceSec, maxNudges, cooldownSec) as NudgeCandidate[];
}
