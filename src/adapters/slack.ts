import { WebClient } from '@slack/web-api';
import { loadScope } from '../scope.js';
import { mightContainCommitment } from '../pre-filter.js';
import { addToBatch, startBatchTimer, stopBatchTimer, flushAll, type MessageBatch } from '../batcher.js';
import { extractCommitments } from '../extract.js';
import { insertCommitment } from '../mutations.js';
import { getDb } from '../db.js';
import { getPactDir } from '../utils.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { AdapterOutput } from '../types.js';

// State: last polled timestamp per channel
interface PollState {
  [channelId: string]: string; // Slack ts format: "1234567890.123456"
}

const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();

function getStatePath(): string {
  return join(getPactDir(), 'slack-poll-state.json');
}

function loadState(): PollState {
  const path = getStatePath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return {};
}

function saveState(state: PollState): void {
  const dir = getPactDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

async function resolveUsername(client: WebClient, userId: string): Promise<string> {
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

async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
  const cached = channelCache.get(channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = result.channel?.name || result.channel?.id || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    // DMs and some channels may not have a name
    channelCache.set(channelId, channelId);
    return channelId;
  }
}

async function stripSlackFormatting(text: string, client: WebClient): Promise<string> {
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

let slackClient: WebClient | null = null;

async function processBatches(batches: MessageBatch[]): Promise<void> {
  const client = slackClient!;
  for (const batch of batches) {
    const combinedText = batch.messages.map(m => m.text).join('\n\n');
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    try {
      // Collect unique participant names for context
      const participantIds = [...new Set(batch.messages.flatMap(m => m.participants))];
      const participantNames = await Promise.all(
        participantIds.map(id => resolveUsername(client, id))
      );

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

interface ChannelInfo {
  id: string;
  updated: number;
  type: 'channel' | 'im' | 'mpim';
  userId?: string; // for DMs — the other person's user ID
  name?: string;
}

async function discoverChannels(client: WebClient): Promise<ChannelInfo[]> {
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

  // Sort by most recently updated first — poll active channels first
  channels.sort((a, b) => b.updated - a.updated);
  return channels;
}

async function listUsers(client: WebClient): Promise<Map<string, string>> {
  const nameToId = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const result = await client.users.list({ limit: 200, cursor });
    for (const user of result.members || []) {
      if (user.id && !user.deleted && !user.is_bot) {
        const name = (user.real_name || user.name || '').toLowerCase();
        if (name) nameToId.set(name, user.id);
        // Also map by username
        if (user.name) nameToId.set(user.name.toLowerCase(), user.id);
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return nameToId;
}

async function resolveSlackScope(
  client: WebClient,
  scope: import('../scope.js').Scope,
  channels: ChannelInfo[]
): Promise<Set<string>> {
  const scopedIds = new Set<string>();

  // Resolve places → channel IDs
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

  // Resolve people → DM channel IDs
  if (scope.people.length > 0) {
    const users = await listUsers(client);

    for (const person of scope.people) {
      const userId = users.get(person);
      if (!userId) {
        console.warn(`Scope: person "${person}" not found in workspace`);
        continue;
      }

      // Find existing DM channel
      const dm = channels.find(ch => ch.type === 'im' && ch.userId === userId);
      if (dm) {
        scopedIds.add(dm.id);
      } else {
        // Open a DM channel
        try {
          const result = await client.conversations.open({ users: userId });
          if (result.channel?.id) {
            scopedIds.add(result.channel.id);
          }
        } catch {
          console.warn(`Scope: could not open DM with "${person}"`);
        }
      }

      // Also include any MPIMs that include this person
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

async function pollChannel(
  client: WebClient,
  channelId: string,
  oldest: string
): Promise<{ messages: AdapterOutput[]; latestTs: string }> {
  const messages: AdapterOutput[] = [];
  let latestTs = oldest;

  try {
    let cursor: string | undefined;
    do {
      const result = await client.conversations.history({
        channel: channelId,
        oldest,
        inclusive: false,
        limit: 200,
        cursor,
      });

      for (const msg of result.messages || []) {
        // Skip bot messages, subtypes (edits, joins, etc.)
        if (msg.subtype) continue;
        if (msg.bot_id) continue;
        if (!msg.text || !msg.ts) continue;

        // Track latest ts for next poll
        if (msg.ts > latestTs) latestTs = msg.ts;

        const cleanText = await stripSlackFormatting(msg.text, client);

        // Pre-filter
        if (!mightContainCommitment(cleanText)) continue;

        const channelName = await resolveChannelName(client, channelId);
        const tsClean = msg.ts.replace('.', '');

        messages.push({
          text: cleanText,
          source: {
            platform: 'slack',
            channel: channelName,
            messageId: msg.ts,
            timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
            url: `https://slack.com/archives/${channelId}/p${tsClean}`,
          },
          participants: [msg.user || 'unknown'],
        });
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (err: unknown) {
    const error = err as { data?: { error?: string } };
    // Handle rate limiting
    if (error.data?.error === 'ratelimited') {
      console.warn(`Rate limited on ${channelId}, will retry next cycle`);
    } else if (error.data?.error === 'channel_not_found' || error.data?.error === 'not_in_channel') {
      // Skip silently — channel may have been deleted or we lost access
    } else {
      console.error(`Error polling ${channelId}: ${(err as Error).message}`);
    }
  }

  return { messages, latestTs };
}

function acquireLock(): boolean {
  const lockPath = join(getPactDir(), 'ingest.lock');
  try {
    if (existsSync(lockPath)) {
      const pid = readFileSync(lockPath, 'utf-8').trim();
      // Check if the process is still running
      try {
        process.kill(parseInt(pid), 0);
        return false; // Process still alive
      } catch {
        // Process is dead, stale lock — remove and proceed
      }
    }
    mkdirSync(getPactDir(), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
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

export async function startSlackAdapter(): Promise<void> {
  const token = process.env.PACT_SLACK_BOT_TOKEN;

  if (!token) {
    console.error('PACT_SLACK_BOT_TOKEN not set');
    process.exit(1);
  }

  if (!acquireLock()) {
    console.error('Another pact ingest is already running. Kill it first or remove ~/.pact/ingest.lock');
    process.exit(1);
  }

  const pollIntervalMs = parseInt(process.env.PACT_SLACK_POLL_INTERVAL || '60') * 1000; // default 60s
  const channelRefreshMs = 10 * 60 * 1000; // rediscover channels every 10 min

  // Initialize
  getDb();
  const client = new WebClient(token);
  slackClient = client;

  // Verify auth
  const auth = await client.auth.test();
  console.log(`Authenticated as ${auth.user} on ${auth.team} (${auth.team_id})`);
  if (auth.enterprise_id) {
    console.log(`Enterprise Grid detected: ${auth.enterprise_id}`);
  }

  // Load poll state. On first run, start from 24h ago (not all history)
  let state = loadState();
  const isFirstRun = Object.keys(state).length === 0;
  if (isFirstRun) {
    const oneDayAgo = String((Date.now() - 86400000) / 1000);
    console.log('First run — scanning last 24 hours only');
    // We'll use this as default oldest for channels with no state
    state.__default = oneDayAgo;
  }

  let channels = await discoverChannels(client);
  let lastChannelRefresh = Date.now();

  // Scope filtering
  const scope = loadScope();
  let scopedChannelIds: Set<string> | null = null;

  if (scope) {
    scopedChannelIds = await resolveSlackScope(client, scope, channels);
    console.log(`Scope: ${scopedChannelIds.size} channel(s) in scope (${scope.places.length} places, ${scope.people.length} people)`);
  } else {
    console.log(`Found ${channels.length} channels/DMs to monitor (no scope set — polling all)`);
  }

  console.log(`Polling every ${pollIntervalMs / 1000}s. Press Ctrl+C to stop.\n`);

  // Start batch processing timer
  startBatchTimer(processBatches);

  let running = true;

  const shutdown = async () => {
    console.log('\nShutting down...');
    running = false;
    stopBatchTimer();

    const remaining = flushAll();
    if (remaining.length > 0) {
      console.log(`Flushing ${remaining.length} remaining batch(es)...`);
      await processBatches(remaining);
    }

    saveState(state);
    releaseLock();
    console.log('State saved. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Main poll loop
  while (running) {
    try {
      // Refresh channel list periodically
      if (Date.now() - lastChannelRefresh > channelRefreshMs) {
        channels = await discoverChannels(client);
        if (scope) scopedChannelIds = await resolveSlackScope(client, scope, channels);
        lastChannelRefresh = Date.now();
      }

      let totalNew = 0;

      // Apply scope filter, then rate limit cap
      const scopeFiltered = scopedChannelIds
        ? channels.filter(ch => scopedChannelIds!.has(ch.id))
        : channels;
      const maxPerCycle = parseInt(process.env.PACT_MAX_CHANNELS_PER_CYCLE || '40');
      const channelsThisCycle = scopeFiltered.slice(0, maxPerCycle);

      for (const channel of channelsThisCycle) {
        if (!running) break;

        const oldest = state[channel.id] || state.__default || '0';
        const { messages, latestTs } = await pollChannel(client, channel.id, oldest);

        if (latestTs > oldest) {
          state[channel.id] = latestTs;
        }

        for (const msg of messages) {
          addToBatch(msg);
          totalNew++;
        }

        // Small delay between channels to respect rate limits
        await new Promise(r => setTimeout(r, 200));
      }

      // Save state after each full cycle
      saveState(state);

    if (totalNew > 0) {
      const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const scopeLabel = scopedChannelIds ? `${channelsThisCycle.length} scoped` : `${channelsThisCycle.length}/${channels.length}`;
      console.log(`[${time}] Poll cycle: ${totalNew} new message(s) with commitment signals from ${scopeLabel} channels`);
    }

    } catch (err) {
      const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      console.error(`[${time}] Poll cycle error: ${(err as Error).message}. Retrying in ${pollIntervalMs / 1000}s...`);
    }

    // Wait before next poll cycle
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}
