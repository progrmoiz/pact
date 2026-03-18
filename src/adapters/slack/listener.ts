import App from '@slack/bolt';
import type { SlackIngestionStrategy } from './types.js';
import type { MessageBatch } from '../../batcher.js';
import { addToBatch, startBatchTimer, stopBatchTimer, flushAll } from '../../batcher.js';
import { mightContainCommitment } from '../../pre-filter.js';
import { loadScope } from '../../scope.js';
import { getDb } from '../../db.js';
import {
  resolveUsername, resolveChannelName, stripSlackFormatting,
  discoverChannels, resolveSlackScope, listUsers, processBatches,
  acquireLock, releaseLock,
} from './shared.js';
import { registerSlackActions } from '../../outputs/slack-dm.js';

/**
 * Team mode: receives real-time events via Slack Socket Mode.
 * Requires bot token (xoxb-) + app-level token (xapp-).
 * Bot must be invited to channels to receive events.
 */
export class SlackListener implements SlackIngestionStrategy {
  private app: InstanceType<typeof App.default> | null = null;

  constructor(
    private botToken: string,
    private appToken: string,
  ) {}

  async start(onBatch: (batches: MessageBatch[]) => Promise<void>): Promise<void> {
    if (!acquireLock()) {
      console.error('Another pact ingest is already running. Kill it first or remove ~/.pact/ingest.lock');
      process.exit(1);
    }

    getDb();

    // Initialize Bolt app with Socket Mode
    const BoltApp = (await import('@slack/bolt')).default?.App || (await import('@slack/bolt') as any).App;
    this.app = new BoltApp({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    // Verify auth
    const client = this.app.client;
    const auth = await client.auth.test({ token: this.botToken });
    console.log(`Team mode: authenticated as ${auth.user} (bot) on ${auth.team} (${auth.team_id})`);
    if (auth.enterprise_id) {
      console.log(`Enterprise Grid: ${auth.enterprise_id}`);
    }

    // Register button action handlers (Done, Snooze, Cancel)
    registerSlackActions(this.app);

    // Scope filtering
    const scope = loadScope();
    let scopedChannelIds: Set<string> | null = null;

    if (scope) {
      const channels = await discoverChannels(client);
      scopedChannelIds = await resolveSlackScope(client, scope, channels);
      console.log(`Scope: ${scopedChannelIds.size} channel(s) in scope`);
    }

    // Start batch processing
    startBatchTimer((batches) => processBatches(batches, client));

    // Listen for all messages
    this.app.message(async ({ message, client: msgClient }) => {
      // Skip bot messages and subtypes (edits, joins, etc.)
      const msg = message as unknown as Record<string, unknown>;
      if (msg.subtype) return;
      if (msg.bot_id) return;
      if (!msg.text || !msg.ts) return;

      const channelId = msg.channel as string;

      // Scope filter: skip if not in scope
      if (scopedChannelIds && !scopedChannelIds.has(channelId)) return;

      const text = msg.text as string;
      const cleanText = await stripSlackFormatting(text, msgClient);

      // Pre-filter
      if (!mightContainCommitment(cleanText)) return;

      const channelName = await resolveChannelName(msgClient, channelId);
      const ts = msg.ts as string;
      const tsClean = ts.replace('.', '');

      addToBatch({
        text: cleanText,
        source: {
          platform: 'slack',
          channel: channelName,
          messageId: ts,
          timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
          url: `https://slack.com/archives/${channelId}/p${tsClean}`,
        },
        participants: [msg.user as string || 'unknown'],
      });
    });

    const shutdown = async () => {
      console.log('\nShutting down...');
      stopBatchTimer();

      const remaining = flushAll();
      if (remaining.length > 0) {
        console.log(`Flushing ${remaining.length} remaining batch(es)...`);
        await processBatches(remaining, this.app!.client);
      }

      await this.app?.stop();
      releaseLock();
      console.log('Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Start Socket Mode connection
    await this.app.start();
    console.log('Connected to Slack via Socket Mode. Listening for commitments...');
    console.log('Note: Bot must be invited to channels to receive events. Use /invite @YourBot');
    console.log('Press Ctrl+C to stop.\n');
  }

  async stop(): Promise<void> {
    await this.app?.stop();
    releaseLock();
  }
}
