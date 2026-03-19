import { getDb } from './db.js';
import { now } from './utils.js';
import type { Commitment, OpenLoop } from './types.js';

/**
 * Compute urgency score (0.0 - 1.0) based on type and age.
 */
export function computeUrgency(type: string, ageSeconds: number, deadline?: string | null): number {
  const ageHours = ageSeconds / 3600;

  if (type === 'slack.dm')           return Math.min(0.3 + ageHours / 16, 0.95);
  if (type === 'slack.mention')      return Math.min(0.2 + ageHours / 24, 0.90);
  if (type === 'slack.thread')       return Math.min(0.15 + ageHours / 32, 0.85);
  if (type === 'github.pr-review')   return Math.min(0.2 + ageHours / 48, 0.90);
  if (type === 'github.issue')       return Math.min(0.1 + ageHours / 168, 0.70);

  if (type === 'commitment' && deadline) {
    const overdueMs = Date.now() - new Date(deadline).getTime();
    if (overdueMs <= 0) return 0.2; // not yet due
    return Math.min(0.5 + (overdueMs / 86400000) / 4, 1.0);
  }

  // Default: linear ramp over 72h
  return Math.min(0.1 + ageHours / 72, 0.70);
}

/**
 * Bridge overdue/active commitments into OpenLoop format.
 */
export function bridgeCommitmentsToLoops(commitments: Commitment[]): OpenLoop[] {
  const nowMs = Date.now();

  return commitments.map(c => {
    const ageSeconds = c.deadline
      ? Math.max(0, (nowMs - new Date(c.deadline).getTime()) / 1000)
      : (nowMs - new Date(c.created_at).getTime()) / 1000;

    return {
      source_ref: `commitment:${c.id}`,
      type: 'commitment',
      title: c.what,
      source_platform: c.source_platform,
      source_channel: c.source_channel || undefined,
      source_url: c.source_url || undefined,
      who_waiting: c.to_whom_name || undefined,
      detected_at: c.created_at,
      urgency: computeUrgency('commitment', ageSeconds, c.deadline),
      commitment_id: c.id,
      metadata: {
        deadline: c.deadline,
        who_name: c.who_name,
        nudge_count: c.nudge_count,
        confidence: c.confidence,
      },
    };
  });
}

/**
 * Get open loops from the cache table.
 */
export function getCachedOpenLoops(): OpenLoop[] {
  const db = getDb();

  // Check if open_loops table exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='open_loops'"
  ).get();

  if (!tableExists) return [];

  const rows = db.prepare(`
    SELECT * FROM open_loops WHERE dismissed = 0
    ORDER BY urgency DESC
  `).all() as Array<{
    source_ref: string;
    type: string;
    title: string;
    source_platform: string;
    source_channel: string | null;
    source_url: string | null;
    who_waiting: string | null;
    detected_at: string;
    urgency: number;
    commitment_id: string | null;
    metadata: string | null;
    dismissed: number;
    last_seen_at: string;
  }>;

  return rows.map(r => ({
    source_ref: r.source_ref,
    type: r.type,
    title: r.title,
    source_platform: r.source_platform,
    source_channel: r.source_channel || undefined,
    source_url: r.source_url || undefined,
    who_waiting: r.who_waiting || undefined,
    detected_at: r.detected_at,
    urgency: r.urgency,
    commitment_id: r.commitment_id || undefined,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

/**
 * Upsert open loops from a scanner into the cache table.
 */
export function upsertOpenLoops(loops: OpenLoop[]): { upserted: number; } {
  const db = getDb();
  const timestamp = now();

  const stmt = db.prepare(`
    INSERT INTO open_loops (source_ref, type, title, source_platform, source_channel,
      source_url, who_waiting, detected_at, urgency, commitment_id, metadata, dismissed, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(source_ref) DO UPDATE SET
      title = excluded.title,
      urgency = excluded.urgency,
      who_waiting = excluded.who_waiting,
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `);

  let upserted = 0;
  for (const loop of loops) {
    stmt.run(
      loop.source_ref,
      loop.type,
      loop.title,
      loop.source_platform,
      loop.source_channel || null,
      loop.source_url || null,
      loop.who_waiting || null,
      loop.detected_at,
      loop.urgency,
      loop.commitment_id || null,
      loop.metadata ? JSON.stringify(loop.metadata) : null,
      timestamp,
    );
    upserted++;
  }

  return { upserted };
}

/**
 * Purge stale loops: anything from this platform not seen in this scan.
 */
export function purgeStaleLoops(platform: string, currentScanTimestamp: string): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM open_loops
    WHERE source_platform = ? AND last_seen_at < ? AND dismissed = 0
  `).run(platform, currentScanTimestamp);
  return result.changes;
}

/**
 * Dismiss an open loop.
 */
export function dismissOpenLoop(sourceRef: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE open_loops SET dismissed = 1, dismissed_at = ? WHERE source_ref = ?
  `).run(now(), sourceRef);
  return result.changes > 0;
}

/**
 * Get ALL open loops: cached scanner results + bridged commitments, merged and sorted.
 */
export function getAllOpenLoops(filters?: {
  type?: string;
  source?: string;
  limit?: number;
}): OpenLoop[] {
  const db = getDb();

  // 1. Get cached open loops from scanners
  const cached = getCachedOpenLoops();

  // 2. Get active commitments (overdue + upcoming within 7 days)
  const commitments = db.prepare(`
    SELECT c.*, i.display_name as who_name, i2.display_name as to_whom_name
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    LEFT JOIN identities i2 ON c.to_whom_id = i2.id
    WHERE c.status = 'active'
      AND (
        (c.deadline IS NOT NULL AND c.deadline < datetime('now', '+7 days'))
        OR (c.deadline IS NOT NULL AND c.deadline < datetime('now'))
      )
    ORDER BY c.deadline ASC NULLS LAST
  `).all() as Commitment[];

  const bridged = bridgeCommitmentsToLoops(commitments);

  // 3. Merge — deduplicate by source_ref (cached scanners win over bridged)
  const seen = new Set<string>();
  const merged: OpenLoop[] = [];

  for (const loop of cached) {
    if (!seen.has(loop.source_ref)) {
      seen.add(loop.source_ref);
      merged.push(loop);
    }
  }

  for (const loop of bridged) {
    if (!seen.has(loop.source_ref)) {
      seen.add(loop.source_ref);
      merged.push(loop);
    }
  }

  // 4. Apply filters
  let filtered = merged;

  if (filters?.type) {
    const typeFilter = filters.type;
    filtered = filtered.filter(l =>
      l.type === typeFilter || l.type.startsWith(typeFilter + '.')
    );
  }

  if (filters?.source) {
    filtered = filtered.filter(l => l.source_platform === filters.source);
  }

  // 5. Sort by urgency DESC
  filtered.sort((a, b) => b.urgency - a.urgency);

  // 6. Limit
  if (filters?.limit) {
    filtered = filtered.slice(0, filters.limit);
  }

  return filtered;
}
