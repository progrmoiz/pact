import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getDbPath } from './utils.js';

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_aliases (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_aliases_identity ON identity_aliases(identity_id);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  who_id TEXT NOT NULL REFERENCES identities(id),
  to_whom_id TEXT REFERENCES identities(id),
  what TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  deadline TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_platform TEXT NOT NULL,
  source_channel TEXT,
  source_message_id TEXT,
  source_url TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudged_at TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_who ON commitments(who_id);
CREATE INDEX IF NOT EXISTS idx_commitments_deadline ON commitments(deadline);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_dedup ON commitments(source_platform, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commitments_source ON commitments(source_platform, source_channel);
CREATE INDEX IF NOT EXISTS idx_commitments_content_hash ON commitments(who_id, content_hash) WHERE status = 'active';
`;

const MIGRATIONS = [MIGRATION_001];

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[i]);
      database.pragma(`user_version = ${i + 1}`);
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
