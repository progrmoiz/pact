import { getDb } from './db.js';
import { genId, now, getWhoami } from './utils.js';
import type { Identity } from './types.js';

export function resolveIdentity(
  name: string | null,
  platform: string,
  participantMap?: Map<string, string>,  // display_name → platform_user_id
): Identity {
  const db = getDb();
  const resolvedName = name || getWhoami();

  if (!resolvedName) {
    throw new Error('No identity found. Set PACT_USER or run: pact whoami <name>');
  }

  const platformUserId = participantMap?.get(resolvedName);
  const timestamp = now();

  // LAYER 1: Platform user ID lookup (strongest signal — beats everything)
  // If participantMap gives us a platform user ID, check if ANY identity already owns it.
  // This handles "Moiz" and "Moiz Farooq" both mapping to U05EHJ53C6P.
  if (platformUserId) {
    const platformAlias = db.prepare(
      'SELECT identity_id FROM identity_aliases WHERE platform = ? AND handle = ?'
    ).get(platform, platformUserId) as { identity_id: string } | undefined;

    if (platformAlias) {
      // Identity exists with this platform ID. Add the current name variation as alias if new.
      db.prepare(
        'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
      ).run(platformAlias.identity_id, 'name', resolvedName, timestamp);

      return db.prepare(
        'SELECT * FROM identities WHERE id = ?'
      ).get(platformAlias.identity_id) as Identity;
    }
  }

  // LAYER 2: Name-based lookup (fallback for stdin / no participantMap)
  const nameAlias = db.prepare(
    'SELECT identity_id FROM identity_aliases WHERE platform = ? AND handle = ?'
  ).get('name', resolvedName) as { identity_id: string } | undefined;

  if (nameAlias) {
    // Found by name. If we have a platform user ID, attach it to this identity.
    if (platformUserId) {
      db.prepare(
        'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
      ).run(nameAlias.identity_id, platform, platformUserId, timestamp);
    }

    return db.prepare(
      'SELECT * FROM identities WHERE id = ?'
    ).get(nameAlias.identity_id) as Identity;
  }

  // LAYER 3: Also check if this name was stored as a platform handle directly
  // (handles legacy data where name was used as handle before participantMap existed)
  if (platform !== 'name') {
    const legacyAlias = db.prepare(
      'SELECT identity_id FROM identity_aliases WHERE platform = ? AND handle = ?'
    ).get(platform, resolvedName) as { identity_id: string } | undefined;

    if (legacyAlias) {
      // Upgrade: add the real platform user ID if available
      if (platformUserId) {
        db.prepare(
          'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
        ).run(legacyAlias.identity_id, platform, platformUserId, timestamp);
      }
      db.prepare(
        'INSERT OR IGNORE INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
      ).run(legacyAlias.identity_id, 'name', resolvedName, timestamp);

      return db.prepare(
        'SELECT * FROM identities WHERE id = ?'
      ).get(legacyAlias.identity_id) as Identity;
    }
  }

  // LAYER 4: No match anywhere — create new identity
  const id = genId();

  const insertIdentity = db.prepare(
    'INSERT INTO identities (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  );
  const insertAlias = db.prepare(
    'INSERT INTO identity_aliases (identity_id, platform, handle, created_at) VALUES (?, ?, ?, ?)'
  );

  db.transaction(() => {
    insertIdentity.run(id, resolvedName, timestamp, timestamp);
    // Always store the name alias
    insertAlias.run(id, 'name', resolvedName, timestamp);
    // Store platform user ID alias if available (e.g., slack:U05EHJ53C6P)
    if (platformUserId && platform !== 'name') {
      insertAlias.run(id, platform, platformUserId, timestamp);
    }
  })();

  return { id, display_name: resolvedName, created_at: timestamp, updated_at: timestamp };
}
