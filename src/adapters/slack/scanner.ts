import { WebClient } from '@slack/web-api';
import type { OpenLoop, OpenLoopScanner } from '../../types.js';
import { resolveUsername, discoverChannels } from './shared.js';
import { computeUrgency } from '../../open-loops.js';
import { now } from '../../utils.js';
import { isObviousCloser, classifyExpectsReply } from '../../classify.js';

/**
 * Slack Open Loop Scanner — detects unreplied DMs and mentions.
 * Hybrid: API detection + regex/LLM classification to filter false positives.
 */
export class SlackScanner implements OpenLoopScanner {
  platform = 'slack';
  private client: WebClient;
  private myUserId: string | null = null;
  private classify: boolean;

  constructor(token: string, options?: { classify?: boolean }) {
    this.client = new WebClient(token);
    this.classify = options?.classify ?? true;
  }

  private async getMyUserId(): Promise<string> {
    if (this.myUserId) return this.myUserId;
    const auth = await this.client.auth.test();
    this.myUserId = auth.user_id as string;
    return this.myUserId;
  }

  async scan(): Promise<OpenLoop[]> {
    const myUserId = await this.getMyUserId();
    const loops: OpenLoop[] = [];

    // Scan unreplied DMs
    const dmLoops = await this.scanUnrepliedDMs(myUserId);
    loops.push(...dmLoops);

    // Scan unreplied mentions
    const mentionLoops = await this.scanUnrepliedMentions(myUserId);
    loops.push(...mentionLoops);

    // Scan my unanswered questions
    const questionLoops = await this.scanMyUnansweredQuestions(myUserId);
    loops.push(...questionLoops);

    return loops;
  }

  /**
   * Find DM conversations where the last message is from someone else
   * and older than the threshold (default 2 hours).
   */
  private async scanUnrepliedDMs(myUserId: string): Promise<OpenLoop[]> {
    const loops: OpenLoop[] = [];
    const channels = await discoverChannels(this.client);
    const dms = channels.filter(ch => ch.type === 'im');
    const thresholdMs = parseInt(process.env.PACT_UNREPLIED_DM_THRESHOLD || '7200') * 1000; // default 2h

    // Limit to most recently active DMs to avoid rate limits
    const maxDMs = parseInt(process.env.PACT_SCAN_MAX_DMS || '50');
    const recentDMs = dms.slice(0, maxDMs);

    for (const dm of recentDMs) {
      try {
        const result = await this.client.conversations.history({
          channel: dm.id,
          limit: 1,
        });

        const lastMsg = result.messages?.[0];
        if (!lastMsg || !lastMsg.ts) continue;

        // Skip: message is from me
        if (lastMsg.user === myUserId) continue;

        // Skip: bot messages, system messages, Slackbot
        if (lastMsg.subtype || lastMsg.bot_id) continue;
        if (lastMsg.user === 'USLACKBOT') continue;
        if (dm.userId === 'USLACKBOT') continue;

        // Skip: not old enough
        const msgTime = parseFloat(lastMsg.ts) * 1000;
        const ageMs = Date.now() - msgTime;
        if (ageMs < thresholdMs) continue;

        // Classify: is someone actually waiting, or is this a conversation closer?
        const preview = (lastMsg.text || '').substring(0, 200);
        if (this.classify) {
          if (isObviousCloser(preview)) continue;
          if (process.env.PACT_LLM_API_KEY) {
            const expectsReply = await classifyExpectsReply(preview);
            if (!expectsReply) continue;
          }
        }

        const fromName = await resolveUsername(this.client, lastMsg.user!);
        const ageSeconds = Math.floor(ageMs / 1000);

        loops.push({
          source_ref: `slack.dm:${dm.id}:${lastMsg.ts}`,
          type: 'slack.dm',
          title: `Reply to ${fromName}`,
          source_platform: 'slack',
          source_channel: fromName,
          source_url: `https://slack.com/archives/${dm.id}/p${lastMsg.ts.replace('.', '')}`,
          who_waiting: fromName,
          detected_at: new Date(msgTime).toISOString(),
          urgency: computeUrgency('slack.dm', ageSeconds),
          metadata: {
            from: fromName,
            from_id: lastMsg.user,
            preview: (lastMsg.text || '').substring(0, 100),
            message_ts: lastMsg.ts,
            channel_id: dm.id,
          },
        });
      } catch {
        // Skip channels we can't access
        continue;
      }
    }

    return loops;
  }

  /**
   * Find @mentions of the user in channels where they haven't replied in the thread.
   */
  private async scanUnrepliedMentions(myUserId: string): Promise<OpenLoop[]> {
    const loops: OpenLoop[] = [];
    const thresholdMs = parseInt(process.env.PACT_UNREPLIED_MENTION_THRESHOLD || '28800') * 1000; // default 8h

    try {
      // Search for recent messages mentioning me
      const searchResult = await this.client.search.messages({
        query: `<@${myUserId}>`,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 30,
      });

      const matches = searchResult.messages?.matches || [];

      for (const match of matches) {
        // Skip messages from myself
        if (match.user === myUserId) continue;

        // Skip old messages (>7 days)
        const msgTime = parseFloat(match.ts!) * 1000;
        const ageMs = Date.now() - msgTime;
        if (ageMs > 7 * 24 * 60 * 60 * 1000) continue;

        // Skip if not old enough for threshold
        if (ageMs < thresholdMs) continue;

        // Check if I replied in the thread
        const threadTs = (match as Record<string, unknown>).thread_ts as string || match.ts;
        if (threadTs && match.channel?.id) {
          try {
            const replies = await this.client.conversations.replies({
              channel: match.channel.id,
              ts: threadTs!,
              limit: 100,
            });

            const iReplied = replies.messages?.some(m => m.user === myUserId && m.ts !== threadTs);
            if (iReplied) continue; // I already responded
          } catch {
            // Can't check replies — include it as a loop
          }
        }

        // Classify: is this mention actually expecting a reply?
        if (this.classify && match.text) {
          const mentionPreview = match.text.substring(0, 200);
          if (isObviousCloser(mentionPreview)) continue;
          if (process.env.PACT_LLM_API_KEY) {
            const expectsReply = await classifyExpectsReply(mentionPreview);
            if (!expectsReply) continue;
          }
        }

        const fromName = await resolveUsername(this.client, match.user!);
        const channelName = match.channel?.name || match.channel?.id || 'unknown';
        const ageSeconds = Math.floor(ageMs / 1000);

        // Dedup: use channel + thread_ts as ref
        const ref = `slack.mention:${match.channel?.id}:${threadTs}`;

        loops.push({
          source_ref: ref,
          type: 'slack.mention',
          title: `Respond to ${fromName} in #${channelName}`,
          source_platform: 'slack',
          source_channel: `#${channelName}`,
          source_url: match.permalink || undefined,
          who_waiting: fromName,
          detected_at: new Date(msgTime).toISOString(),
          urgency: computeUrgency('slack.mention', ageSeconds),
          metadata: {
            from: fromName,
            from_id: match.user,
            preview: (match.text || '').substring(0, 100),
            channel_id: match.channel?.id,
            thread_ts: threadTs,
          },
        });
      }
    } catch (err) {
      // search.messages might not be available with all token types
      console.warn(`Slack mention scan skipped: ${(err as Error).message}`);
    }

    return loops;
  }

  /**
   * Find questions I asked that nobody has answered yet.
   * Inspired by Vercel's Nudge — uses search.messages with "from:me ?"
   */
  private async scanMyUnansweredQuestions(myUserId: string): Promise<OpenLoop[]> {
    const loops: OpenLoop[] = [];
    const thresholdMs = parseInt(process.env.PACT_QUESTION_THRESHOLD || '14400') * 1000; // default 4h

    try {
      const searchResult = await this.client.search.messages({
        query: `from:<@${myUserId}> ?`,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 30,
      });

      const matches = searchResult.messages?.matches || [];

      for (const match of matches) {
        // Must be from me
        if (match.user !== myUserId) continue;

        // Must be a real question (not just a URL with query string)
        if (!match.text || !isLikelyQuestion(match.text)) continue;

        const msgTime = parseFloat(match.ts!) * 1000;
        const ageMs = Date.now() - msgTime;

        // Skip if > 7 days old
        if (ageMs > 7 * 24 * 60 * 60 * 1000) continue;

        // Skip if not old enough
        if (ageMs < thresholdMs) continue;

        // Check if someone else replied
        const threadTs = (match as Record<string, unknown>).thread_ts as string || match.ts;
        if (threadTs && match.channel?.id) {
          try {
            const replies = await this.client.conversations.replies({
              channel: match.channel.id,
              ts: threadTs!,
              limit: 50,
            });

            const someoneElseReplied = replies.messages?.some(
              m => m.user !== myUserId && m.ts !== threadTs && !m.bot_id && !(m as Record<string, unknown>).subtype
            );
            if (someoneElseReplied) continue; // Got an answer
          } catch {
            // Can't check replies — skip to be safe
            continue;
          }
        }

        const channelName = match.channel?.name || match.channel?.id || 'unknown';
        const ageSeconds = Math.floor(ageMs / 1000);
        const ref = `slack.question:${match.channel?.id}:${match.ts}`;

        loops.push({
          source_ref: ref,
          type: 'slack.question',
          title: `Waiting for answer in #${channelName}`,
          source_platform: 'slack',
          source_channel: `#${channelName}`,
          source_url: match.permalink || undefined,
          who_waiting: 'me',
          detected_at: new Date(msgTime).toISOString(),
          urgency: computeUrgency('slack.question', ageSeconds),
          metadata: {
            preview: match.text.substring(0, 100),
            channel_id: match.channel?.id,
            thread_ts: threadTs,
          },
        });
      }
    } catch (err) {
      console.warn(`Slack question scan skipped: ${(err as Error).message}`);
    }

    return loops;
  }
}

function isLikelyQuestion(text: string): boolean {
  if (!text.includes('?')) return false;
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/g, '');
  if (!withoutUrls.includes('?')) return false;
  if (text.trim().length < 5) return false;
  return true;
}
