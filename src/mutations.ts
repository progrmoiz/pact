import { getDb } from './db.js';
import { genId, now, setWhoamiFile } from './utils.js';
import { resolveIdentity } from './identity.js';
import type { Commitment, Identity } from './types.js';

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
}): Commitment {
  const db = getDb();
  const id = genId();
  const timestamp = now();

  const whoIdentity = resolveIdentity(data.who, data.source_platform);
  let toWhomIdentity: Identity | null = null;
  if (data.to_whom) {
    toWhomIdentity = resolveIdentity(data.to_whom, data.source_platform);
  }

  db.prepare(`
    INSERT INTO commitments (
      id, who_id, to_whom_id, what, raw_text, deadline, confidence,
      status, source_platform, source_channel, source_message_id, source_url,
      nudge_count, escalated, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    id, whoIdentity.id, toWhomIdentity?.id || null,
    data.what, data.raw_text, data.deadline, data.confidence,
    data.source_platform, data.source_channel || null,
    data.source_message_id || null, data.source_url || null,
    timestamp, timestamp
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
