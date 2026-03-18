import { getDb } from './db.js';
import { genId, now, getWhoami } from './utils.js';
import type { Identity } from './types.js';

export function resolveIdentity(name: string | null, platform: string): Identity {
  const db = getDb();
  const resolvedName = name || getWhoami();

  if (!resolvedName) {
    throw new Error('No identity found. Set PACT_USER or run: pact whoami <name>');
  }

  // Look up by alias
  const alias = db.prepare(
    'SELECT identity_id FROM identity_aliases WHERE platform = ? AND handle = ?'
  ).get(platform, resolvedName) as { identity_id: string } | undefined;

  if (alias) {
    const identity = db.prepare(
      'SELECT * FROM identities WHERE id = ?'
    ).get(alias.identity_id) as Identity;
    return identity;
  }

  // Also check by name alias
  if (platform !== 'name') {
    const nameAlias = db.prepare(
      'SELECT identity_id FROM identity_aliases WHERE platform = ? AND handle = ?'
    ).get('name', resolvedName) as { identity_id: string } | undefined;

    if (nameAlias) {
      // Found by name, add platform alias too
      const timestamp = now();
      db.prepare(
        'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
      ).run(nameAlias.identity_id, platform, resolvedName, timestamp);

      const identity = db.prepare(
        'SELECT * FROM identities WHERE id = ?'
      ).get(nameAlias.identity_id) as Identity;
      return identity;
    }
  }

  // Create new identity + alias
  const id = genId();
  const timestamp = now();

  const insertIdentity = db.prepare(
    'INSERT INTO identities (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  );
  const insertAlias = db.prepare(
    'INSERT INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
  );

  db.transaction(() => {
    insertIdentity.run(id, resolvedName, timestamp, timestamp);
    insertAlias.run(id, platform, resolvedName, timestamp);
    if (platform !== 'name') {
      insertAlias.run(id, 'name', resolvedName, timestamp);
    }
  })();

  return { id, display_name: resolvedName, created_at: timestamp, updated_at: timestamp };
}
