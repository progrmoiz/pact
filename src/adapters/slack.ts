import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import { mightContainCommitment } from '../pre-filter.js';
import { addToBatch, startBatchTimer, stopBatchTimer, flushAll, type MessageBatch } from '../batcher.js';
import { extractCommitments } from '../extract.js';
import { insertCommitment } from '../mutations.js';
import { getDb } from '../db.js';
import type { AdapterOutput } from '../types.js';

const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();

async function resolveUsername(app: App, userId: string): Promise<string> {
  const cached = userCache.get(userId);
  if (cached) return cached;

  try {
    const result = await app.client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function resolveChannelName(app: App, channelId: string): Promise<string> {
  const cached = channelCache.get(channelId);
  if (cached) return cached;

  try {
    const result = await app.client.conversations.info({ channel: channelId });
    const name = result.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

async function stripSlackFormatting(text: string, app: App): Promise<string> {
  let result = text;

  // Replace user mentions <@U123>
  const userMentions = result.match(/<@(U[A-Z0-9]+)>/g);
  if (userMentions) {
    for (const mention of userMentions) {
      const userId = mention.slice(2, -1);
      const name = await resolveUsername(app, userId);
      result = result.replace(mention, `@${name}`);
    }
  }

  // Replace channel mentions <#C123|channel-name>
  result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  // Replace channel mentions without label <#C123>
  result = result.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // Replace URLs with labels <url|label>
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2');
  // Replace bare URLs <url>
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Strip formatting markers
  result = result.replace(/[*_~`]/g, '');

  return result;
}

async function processBatches(batches: MessageBatch[]): Promise<void> {
  for (const batch of batches) {
    const combinedText = batch.messages.map(m => m.text).join('\n\n');
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    try {
      const results = await extractCommitments(combinedText);

      if (results.length > 0) {
        for (const r of results) {
          insertCommitment({
            who: r.who,
            to_whom: r.to_whom,
            what: r.what,
            raw_text: combinedText,
            deadline: r.deadline,
            confidence: r.confidence,
            source_platform: 'slack',
            source_channel: batch.channel ? `#${batch.channel}` : undefined,
            source_message_id: batch.messages[0].source.messageId,
            source_url: batch.messages[0].source.url,
          });
        }
        console.log(`[${time} #${batch.channel || 'default'}] ${results.length} commitment(s) extracted`);
      } else {
        console.log(`[${time} #${batch.channel || 'default'}] ${batch.messages.length} message(s), no commitments`);
      }
    } catch (err) {
      console.error(`[${time} #${batch.channel || 'default'}] Error: ${(err as Error).message}`);
    }
  }
}

export async function startSlackAdapter(): Promise<void> {
  const botToken = process.env.PACT_SLACK_BOT_TOKEN;
  const appToken = process.env.PACT_SLACK_APP_TOKEN;

  if (!botToken) {
    console.error('PACT_SLACK_BOT_TOKEN not set');
    process.exit(1);
  }
  if (!appToken) {
    console.error('PACT_SLACK_APP_TOKEN not set');
    process.exit(1);
  }

  // Initialize DB
  getDb();

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Register action handlers for follow-up buttons
  const { registerSlackActions } = await import('../outputs/slack-dm.js');
  registerSlackActions(app);

  app.message(async ({ message }) => {
    const msg = message as GenericMessageEvent;

    // Skip bot messages and subtypes (edits, deletes, etc.)
    if (msg.subtype) return;
    if (!msg.text) return;

    const cleanText = await stripSlackFormatting(msg.text, app);

    // Pre-filter
    if (!mightContainCommitment(cleanText)) return;

    const channelName = await resolveChannelName(app, msg.channel);
    const ts = msg.ts.replace('.', '');

    const output: AdapterOutput = {
      text: cleanText,
      source: {
        platform: 'slack',
        channel: channelName,
        messageId: msg.ts,
        timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        url: `https://slack.com/archives/${msg.channel}/p${ts}`,
      },
      participants: [msg.user || 'unknown'],
    };

    addToBatch(output);
  });

  // Start batch processing timer (check every 30s)
  startBatchTimer(processBatches);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    stopBatchTimer();

    // Flush remaining batches
    const remaining = flushAll();
    if (remaining.length > 0) {
      console.log(`Flushing ${remaining.length} remaining batch(es)...`);
      await processBatches(remaining);
    }

    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.start();
  console.log('Connected to Slack. Listening for commitments...');
  console.log('Press Ctrl+C to stop.\n');
}
