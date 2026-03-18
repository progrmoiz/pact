import { WebClient } from '@slack/web-api';
import type { SlackIngestionStrategy, ChannelInfo } from './types.js';
import type { AdapterOutput } from '../../types.js';
import type { MessageBatch } from '../../batcher.js';
import { addToBatch, startBatchTimer, stopBatchTimer, flushAll } from '../../batcher.js';
import { mightContainCommitment } from '../../pre-filter.js';
import { loadScope } from '../../scope.js';
import { getDb } from '../../db.js';
import {
  resolveUsername, resolveChannelName, stripSlackFormatting,
  discoverChannels, resolveSlackScope, processBatches,
  acquireLock, releaseLock, loadPollState, savePollState,
} from './shared.js';

/**
 * Solo mode: polls conversations.history with a user token.
 * Invisible — no bot presence in channels. Works on all Slack plans including Enterprise Grid.
 */
export class SlackPoller implements SlackIngestionStrategy {
  private client: WebClient;
  private running = false;

  constructor(private token: string) {
    this.client = new WebClient(token);
  }

  async start(onBatch: (batches: MessageBatch[]) => Promise<void>): Promise<void> {
    if (!acquireLock()) {
      console.error('Another pact ingest is already running. Kill it first or remove ~/.pact/ingest.lock');
      process.exit(1);
    }

    const pollIntervalMs = parseInt(process.env.PACT_SLACK_POLL_INTERVAL || '60') * 1000;
    const channelRefreshMs = 10 * 60 * 1000;

    getDb();

    // Verify auth
    const auth = await this.client.auth.test();
    console.log(`Solo mode: authenticated as ${auth.user} on ${auth.team} (${auth.team_id})`);
    if (auth.enterprise_id) {
      console.log(`Enterprise Grid: ${auth.enterprise_id}`);
    }

    // Load poll state
    let state = loadPollState();
    const isFirstRun = Object.keys(state).length === 0;
    if (isFirstRun) {
      const oneDayAgo = String((Date.now() - 86400000) / 1000);
      console.log('First run — scanning last 24 hours only');
      state.__default = oneDayAgo;
    }

    let channels = await discoverChannels(this.client);
    let lastChannelRefresh = Date.now();

    // Scope filtering
    const scope = loadScope();
    let scopedChannelIds: Set<string> | null = null;

    if (scope) {
      scopedChannelIds = await resolveSlackScope(this.client, scope, channels);
      console.log(`Scope: ${scopedChannelIds.size} channel(s) in scope (${scope.places.length} places, ${scope.people.length} people)`);
    } else {
      console.log(`Found ${channels.length} channels/DMs to monitor (no scope set — polling all)`);
    }

    console.log(`Polling every ${pollIntervalMs / 1000}s. Press Ctrl+C to stop.\n`);

    // Start batch processing
    startBatchTimer((batches) => processBatches(batches, this.client));
    this.running = true;

    const shutdown = async () => {
      console.log('\nShutting down...');
      this.running = false;
      stopBatchTimer();

      const remaining = flushAll();
      if (remaining.length > 0) {
        console.log(`Flushing ${remaining.length} remaining batch(es)...`);
        await processBatches(remaining, this.client);
      }

      savePollState(state);
      releaseLock();
      console.log('State saved. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Main poll loop
    while (this.running) {
      try {
        if (Date.now() - lastChannelRefresh > channelRefreshMs) {
          channels = await discoverChannels(this.client);
          if (scope) scopedChannelIds = await resolveSlackScope(this.client, scope, channels);
          lastChannelRefresh = Date.now();
        }

        let totalNew = 0;

        const scopeFiltered = scopedChannelIds
          ? channels.filter(ch => scopedChannelIds!.has(ch.id))
          : channels;
        const maxPerCycle = parseInt(process.env.PACT_MAX_CHANNELS_PER_CYCLE || '40');
        const channelsThisCycle = scopeFiltered.slice(0, maxPerCycle);

        for (const channel of channelsThisCycle) {
          if (!this.running) break;

          const oldest = state[channel.id] || state.__default || '0';
          const { messages, latestTs } = await this.pollChannel(channel.id, oldest);

          if (latestTs > oldest) {
            state[channel.id] = latestTs;
          }

          for (const msg of messages) {
            addToBatch(msg);
            totalNew++;
          }

          await new Promise(r => setTimeout(r, 200));
        }

        savePollState(state);

        if (totalNew > 0) {
          const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const scopeLabel = scopedChannelIds ? `${channelsThisCycle.length} scoped` : `${channelsThisCycle.length}/${channels.length}`;
          console.log(`[${time}] Poll cycle: ${totalNew} new message(s) with commitment signals from ${scopeLabel} channels`);
        }

      } catch (err) {
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        console.error(`[${time}] Poll cycle error: ${(err as Error).message}. Retrying in ${pollIntervalMs / 1000}s...`);
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    releaseLock();
  }

  private async pollChannel(
    channelId: string,
    oldest: string
  ): Promise<{ messages: AdapterOutput[]; latestTs: string }> {
    const messages: AdapterOutput[] = [];
    let latestTs = oldest;

    try {
      let cursor: string | undefined;
      do {
        const result = await this.client.conversations.history({
          channel: channelId,
          oldest,
          inclusive: false,
          limit: 200,
          cursor,
        });

        for (const msg of result.messages || []) {
          if (msg.subtype) continue;
          if (msg.bot_id) continue;
          if (!msg.text || !msg.ts) continue;

          if (msg.ts > latestTs) latestTs = msg.ts;

          const cleanText = await stripSlackFormatting(msg.text, this.client);
          if (!mightContainCommitment(cleanText)) continue;

          const channelName = await resolveChannelName(this.client, channelId);
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
      if (error.data?.error === 'ratelimited') {
        console.warn(`Rate limited on ${channelId}, will retry next cycle`);
      } else if (error.data?.error === 'channel_not_found' || error.data?.error === 'not_in_channel') {
        // Skip silently
      } else {
        console.error(`Error polling ${channelId}: ${(err as Error).message}`);
      }
    }

    return { messages, latestTs };
  }
}
