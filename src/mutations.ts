import { createHash } from 'crypto';
import { getDb } from './db.js';
import { genId, now, setWhoamiFile } from './utils.js';
import { resolveIdentity } from './identity.js';
import type { Commitment, Identity } from './types.js';

export type InsertResult = { commitment: Commitment; status: 'new' | 'duplicate' };

function contentHash(who: string, what: string, channel: string | null): string {
  return createHash('sha256')
    .update(`${who}::${what.toLowerCase().trim()}::${channel || ''}`)
    .digest('hex')
    .substring(0, 16);
}

export function insertCommitment(data: {
  who: string | null;
  to_whom: string | null;
  what: string;
  raw_text: string;
  deadline: string | null;
  confidence: number;
  source_platform: string;
  source_channel?: string | null;
  source_message_id?: string | null;
  source_url?: string | null;
  participant_map?: Map<string, string>;  // display_name → platform_user_id
}): Commitment | null {
  const db = getDb();
  const id = genId();
  const timestamp = now();

  const whoIdentity = resolveIdentity(data.who, data.source_platform, data.participant_map);
  let toWhomIdentity: Identity | null = null;
  if (data.to_whom) {
    toWhomIdentity = resolveIdentity(data.to_whom, data.source_platform, data.participant_map);
  }

  // Layer 1: Content-level dedup — same person, same action, same channel = duplicate
  const hash = contentHash(whoIdentity.display_name, data.what, data.source_channel || null);
  const existing = db.prepare(`
    SELECT id FROM commitments
    WHERE who_id = ? AND status = 'active' AND content_hash = ?
  `).get(whoIdentity.id, hash) as { id: string } | undefined;

  if (existing) return null; // Duplicate — silently skip

  // Layer 2: Message-level dedup (source_platform + source_message_id unique index)
  db.prepare(`
    INSERT OR IGNORE INTO commitments (
      id, who_id, to_whom_id, what, raw_text, deadline, confidence,
      status, source_platform, source_channel, source_message_id, source_url,
      content_hash, nudge_count, escalated, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    id, whoIdentity.id, toWhomIdentity?.id || null,
    data.what, data.raw_text, data.deadline, data.confidence,
    data.source_platform, data.source_channel || null,
    data.source_message_id || null, data.source_url || null,
    hash, timestamp, timestamp
  );

  return {
    id,
    who_id: whoIdentity.id,
    who_name: whoIdentity.display_name,
    to_whom_id: toWhomIdentity?.id || null,
    to_whom_name: toWhomIdentity?.display_name,
    what: data.what,
    raw_text: data.raw_text,
    deadline: data.deadline,
    confidence: data.confidence,
    status: 'active',
    source_platform: data.source_platform,
    source_channel: data.source_channel || null,
    source_message_id: data.source_message_id || null,
    source_url: data.source_url || null,
    resolved_at: null,
    resolution_note: null,
    nudge_count: 0,
    last_nudged_at: null,
    escalated: 0,
    escalated_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function resolveCommitment(
  id: string,
  status: 'done' | 'cancelled',
  note?: string
): Commitment {
  const db = getDb();
  const timestamp = now();

  const existing = db.prepare(`
    SELECT c.*, i.display_name as who_name
    FROM commitments c JOIN identities i ON c.who_id = i.id
    WHERE c.id = ?
  `).get(id) as Commitment | undefined;

  if (!existing) throw new Error(`Commitment not found: ${id}`);
  if (existing.status !== 'active') throw new Error(`Commitment already ${existing.status}`);

  db.prepare(`
    UPDATE commitments SET status = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
    WHERE id = ?
  `).run(status, timestamp, note || null, timestamp, id);

  return { ...existing, status, resolved_at: timestamp, resolution_note: note || null, updated_at: timestamp };
}

export function snoozeCommitment(id: string, newDeadline: string): Commitment {
  const db = getDb();
  const timestamp = now();

  const existing = db.prepare(`
    SELECT c.*, i.display_name as who_name
    FROM commitments c JOIN identities i ON c.who_id = i.id
    WHERE c.id = ?
  `).get(id) as Commitment | undefined;

  if (!existing) throw new Error(`Commitment not found: ${id}`);
  if (existing.status !== 'active') throw new Error(`Commitment already ${existing.status}`);

  db.prepare(`
    UPDATE commitments SET deadline = ?, updated_at = ? WHERE id = ?
  `).run(newDeadline, timestamp, id);

  return { ...existing, deadline: newDeadline, updated_at: timestamp };
}

export function mergeIdentities(keepId: string, mergeId: string): { merged: number; aliases: number } {
  const db = getDb();
  const timestamp = now();

  const keep = db.prepare('SELECT * FROM identities WHERE id = ?').get(keepId) as Identity | undefined;
  const merge = db.prepare('SELECT * FROM identities WHERE id = ?').get(mergeId) as Identity | undefined;

  if (!keep) throw new Error(`Identity not found: ${keepId}`);
  if (!merge) throw new Error(`Identity not found: ${mergeId}`);
  if (keepId === mergeId) throw new Error('Cannot merge an identity with itself');

  let commitmentsMoved = 0;
  let aliasesMoved = 0;

  db.transaction(() => {
    // Move all commitments from merge → keep
    const whoResult = db.prepare('UPDATE commitments SET who_id = ?, updated_at = ? WHERE who_id = ?')
      .run(keepId, timestamp, mergeId);
    const toWhomResult = db.prepare('UPDATE commitments SET to_whom_id = ?, updated_at = ? WHERE to_whom_id = ?')
      .run(keepId, timestamp, mergeId);
    commitmentsMoved = whoResult.changes + toWhomResult.changes;

    // Move aliases — skip any that would conflict (same platform+handle already on keep)
    const mergeAliases = db.prepare('SELECT platform, handle FROM identity_aliases WHERE identity_id = ?')
      .all(mergeId) as { platform: string; handle: string }[];

    for (const alias of mergeAliases) {
      const existing = db.prepare(
        'SELECT 1 FROM identity_aliases WHERE platform = ? AND handle = ?'
      ).get(alias.platform, alias.handle) as unknown;

      // If this exact alias belongs to the merge identity, reassign it
      db.prepare(
        'DELETE FROM identity_aliases WHERE identity_id = ? AND platform = ? AND handle = ?'
      ).run(mergeId, alias.platform, alias.handle);

      if (!existing || existing) {
        // Insert under keep (ignore if duplicate)
        db.prepare(
          'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
        ).run(keepId, alias.platform, alias.handle, timestamp);
        aliasesMoved++;
      }
    }

    // Delete the merged identity
    db.prepare('DELETE FROM identities WHERE id = ?').run(mergeId);
  })();

  return { merged: commitmentsMoved, aliases: aliasesMoved };
}

export function listIdentities(): (Identity & { aliases: { platform: string; handle: string }[] })[] {
  const db = getDb();
  const identities = db.prepare('SELECT * FROM identities ORDER BY display_name').all() as Identity[];
  return identities.map(i => {
    const aliases = db.prepare(
      'SELECT platform, handle FROM identity_aliases WHERE identity_id = ? ORDER BY platform'
    ).all(i.id) as { platform: string; handle: string }[];
    return { ...i, aliases };
  });
}

export function setWhoami(name: string): Identity {
  setWhoamiFile(name);
  return resolveIdentity(name, 'name');
}

export function incrementNudge(id: string): void {
  const db = getDb();
  const timestamp = now();
  db.prepare(`
    UPDATE commitments SET nudge_count = nudge_count + 1, last_nudged_at = ?, updated_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, id);
}

export function markEscalated(id: string): void {
  const db = getDb();
  const timestamp = now();
  db.prepare(`
    UPDATE commitments SET escalated = 1, escalated_at = ?, updated_at = ?
    WHERE id = ?
  `).run(timestamp, timestamp, id);
}

export function editCommitment(
  id: string,
  updates: Record<string, string>,
  who?: string,
): Commitment {
  const db = getDb();
  const timestamp = now();

  const existing = db.prepare(`
    SELECT c.*, i.display_name as who_name
    FROM commitments c JOIN identities i ON c.who_id = i.id
    WHERE c.id = ?
  `).get(id) as Commitment | undefined;

  if (!existing) throw new Error(`Commitment not found: ${id}`);

  const setClauses: string[] = ['updated_at = ?'];
  const params: string[] = [timestamp];

  if (updates.what) {
    setClauses.push('what = ?');
    params.push(updates.what);
  }
  if (updates.deadline) {
    setClauses.push('deadline = ?');
    params.push(updates.deadline);
  }
  if (who) {
    const identity = resolveIdentity(who, 'name');
    setClauses.push('who_id = ?');
    params.push(identity.id);
  }

  params.push(id);
  db.prepare(`UPDATE commitments SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  return {
    ...existing,
    what: updates.what || existing.what,
    deadline: updates.deadline || existing.deadline,
    updated_at: timestamp,
  };
}
