-- Pact initial schema
-- Three tables: identities, identity_aliases, commitments

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_who ON commitments(who_id);
CREATE INDEX IF NOT EXISTS idx_commitments_deadline ON commitments(deadline);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_dedup ON commitments(source_platform, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commitments_source ON commitments(source_platform, source_channel);
