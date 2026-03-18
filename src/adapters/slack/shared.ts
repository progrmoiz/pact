import { WebClient } from '@slack/web-api';
import type { AdapterOutput } from '../../types.js';
import type { ChannelInfo } from './types.js';
import type { MessageBatch } from '../../batcher.js';
import { mightContainCommitment } from '../../pre-filter.js';
import { extractCommitments } from '../../extract.js';
import { insertCommitment } from '../../mutations.js';
import { loadScope, type Scope } from '../../scope.js';
import { getPactDir } from '../../utils.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Caches shared across the adapter
const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();

export async function resolveUsername(client: WebClient, userId: string): Promise<string> {
  const cached = userCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
  const cached = channelCache.get(channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = result.channel?.name || result.channel?.id || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    channelCache.set(channelId, channelId);
    return channelId;
  }
}

export async function stripSlackFormatting(text: string, client: WebClient): Promise<string> {
  let result = text;

  // Replace user mentions <@U123>
  const userMentions = result.match(/<@(U[A-Z0-9]+)>/g);
  if (userMentions) {
    for (const mention of userMentions) {
      const userId = mention.slice(2, -1);
      const name = await resolveUsername(client, userId);
      result = result.replace(mention, `@${name}`);
    }
  }

  // Replace channel mentions <#C123|channel-name>
  result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  result = result.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // Replace URLs with labels <url|label>
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2');
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Strip formatting markers
  result = result.replace(/[*_~`]/g, '');

  return result;
}

export async function discoverChannels(client: WebClient): Promise<ChannelInfo[]> {
  const channels: ChannelInfo[] = [];
  const types = 'public_channel,private_channel,im,mpim';

  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types,
      limit: 200,
      cursor,
      exclude_archived: true,
    });

    for (const ch of result.channels || []) {
      if (ch.id) {
        const rawCh = ch as Record<string, unknown>;
        const isIm = rawCh.is_im === true;
        const isMpim = rawCh.is_mpim === true;
        channels.push({
          id: ch.id,
          updated: rawCh.updated as number || 0,
          type: isIm ? 'im' : isMpim ? 'mpim' : 'channel',
          userId: isIm ? rawCh.user as string : undefined,
          name: ch.name,
        });
        if (ch.name) channelCache.set(ch.id, ch.name);
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Sort by most recently updated first
  channels.sort((a, b) => b.updated - a.updated);
  return channels;
}

interface SlackUser {
  id: string;
  username: string;
  realName: string;
}

export async function listUsers(client: WebClient): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.users.list({ limit: 200, cursor });
    for (const user of result.members || []) {
      if (user.id && !user.deleted && !user.is_bot) {
        users.push({
          id: user.id,
          username: (user.name || '').toLowerCase(),
          realName: (user.real_name || '').toLowerCase(),
        });
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return users;
}

function findUser(users: SlackUser[], query: string): string | undefined {
  // Tier 1: exact match on username or full real_name
  const exact = users.filter(
    u => u.username === query || u.realName === query
  );
  if (exact.length === 1) return exact[0].id;

  // Tier 2: token match — query matches any word in real_name
  const token = users.filter(
    u => u.realName.split(' ').includes(query)
  );
  if (token.length === 1) return token[0].id;

  // Tier 3: substring match on username or real_name
  const substring = users.filter(
    u => u.username.includes(query) || u.realName.includes(query)
  );
  if (substring.length === 1) return substring[0].id;

  // Ambiguous — warn with candidates
  const allMatches = [...new Map([...exact, ...token, ...substring].map(u => [u.id, u])).values()];
  if (allMatches.length > 1) {
    console.warn(
      `Scope: "${query}" matches multiple users: ${allMatches.map(u => `${u.realName} (@${u.username})`).join(', ')}. Be more specific.`
    );
  }
  return undefined;
}

export async function resolveSlackScope(
  client: WebClient,
  scope: Scope,
  channels: ChannelInfo[]
): Promise<Set<string>> {
  const scopedIds = new Set<string>();

  // Resolve places -> channel IDs
  for (const place of scope.places) {
    const match = channels.find(
      ch => ch.type === 'channel' && ch.name?.toLowerCase() === place
    );
    if (match) {
      scopedIds.add(match.id);
    } else {
      console.warn(`Scope: channel "${place}" not found`);
    }
  }

  // Resolve people -> DM channel IDs
  if (scope.people.length > 0) {
    const users = await listUsers(client);

    for (const person of scope.people) {
      const userId = findUser(users, person);
      if (!userId) {
        console.warn(`Scope: person "${person}" not found in workspace`);
        continue;
      }

      const dm = channels.find(ch => ch.type === 'im' && ch.userId === userId);
      if (dm) {
        scopedIds.add(dm.id);
      } else {
        try {
          const result = await client.conversations.open({ users: userId });
          if (result.channel?.id) {
            scopedIds.add(result.channel.id);
          }
        } catch {
          console.warn(`Scope: could not open DM with "${person}"`);
        }
      }

      // Include MPIMs with this person
      for (const ch of channels) {
        if (ch.type === 'mpim') {
          try {
            const info = await client.conversations.members({ channel: ch.id, limit: 100 });
            if (info.members?.includes(userId)) {
              scopedIds.add(ch.id);
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  return scopedIds;
}

/**
 * Process extracted batches — shared between poller and listener.
 */
export async function processBatches(batches: MessageBatch[], client: WebClient): Promise<void> {
  for (const batch of batches) {
    const combinedText = batch.messages.map(m => m.text).join('\n\n');
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    try {
      const participantIds = [...new Set(batch.messages.flatMap(m => m.participants))];
      const participantNames = await Promise.all(
        participantIds.map(id => resolveUsername(client, id))
      );

      // Build name → platform_user_id map so identity system stores Slack user IDs, not display names
      const participantMap = new Map<string, string>();
      for (let i = 0; i < participantIds.length; i++) {
        participantMap.set(participantNames[i], participantIds[i]);
      }

      const results = await extractCommitments(combinedText, {
        participants: participantNames,
        channel: batch.channel,
      });

      if (results.length > 0) {
        const batchMessageId = batch.messages.map(m => m.source.messageId).join(',');
        let newCount = 0;
        for (const r of results) {
          const commitment = insertCommitment({
            who: r.who,
            to_whom: r.to_whom,
            what: r.what,
            raw_text: combinedText,
            deadline: r.deadline,
            confidence: r.confidence,
            source_platform: 'slack',
            source_channel: batch.channel ? `#${batch.channel}` : undefined,
            source_message_id: batchMessageId,
            source_url: batch.messages[0].source.url,
            participant_map: participantMap,
          });
          if (commitment) newCount++;
        }
        if (newCount > 0) {
          console.log(`[${time} #${batch.channel || 'dm'}] ${newCount} new commitment(s) (${results.length - newCount} duplicates skipped)`);
        }
      } else {
        console.log(`[${time} #${batch.channel || 'dm'}] ${batch.messages.length} message(s), no commitments`);
      }
    } catch (err) {
      console.error(`[${time} #${batch.channel || 'dm'}] Error: ${(err as Error).message}`);
    }
  }
}

// --- Lock management ---

export function acquireLock(): boolean {
  const lockPath = join(getPactDir(), 'ingest.lock');
  try {
    if (existsSync(lockPath)) {
      const pid = readFileSync(lockPath, 'utf-8').trim();
      try {
        process.kill(parseInt(pid), 0);
        return false; // Process still alive
      } catch {
        // Stale lock
      }
    }
    mkdirSync(getPactDir(), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  const lockPath = join(getPactDir(), 'ingest.lock');
  try {
    if (existsSync(lockPath)) {
      const pid = readFileSync(lockPath, 'utf-8').trim();
      if (pid === String(process.pid)) {
        unlinkSync(lockPath);
      }
    }
  } catch { /* ignore */ }
}

// --- Poll state persistence ---

export function getStatePath(): string {
  return join(getPactDir(), 'slack-poll-state.json');
}

export function loadPollState(): Record<string, string> {
  const path = getStatePath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return {};
}

export function savePollState(state: Record<string, string>): void {
  const dir = getPactDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}
