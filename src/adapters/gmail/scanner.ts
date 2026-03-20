import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { OpenLoop, OpenLoopScanner } from '../../types.js';
import { computeUrgency } from '../../open-loops.js';
import { isMassEmail } from './filters.js';

const BATCH_SIZE = 10;

/**
 * Gmail Open Loop Scanner — detects unreplied emails.
 * API-only, zero LLM cost. Self-resolving.
 *
 * Tiers: gmail.unreplied (To: me) vs gmail.cc (CC'd only, lower urgency).
 */
export class GmailScanner implements OpenLoopScanner {
  platform = 'gmail';
  private auth: OAuth2Client;
  private myEmail: string | null = null;

  constructor(auth: OAuth2Client) {
    this.auth = auth;
  }

  private async getMyEmail(): Promise<string> {
    if (this.myEmail) return this.myEmail;
    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    this.myEmail = profile.data.emailAddress!;
    return this.myEmail;
  }

  async scan(): Promise<OpenLoop[]> {
    const myEmail = await this.getMyEmail();
    const gmailApi = google.gmail({ version: 'v1', auth: this.auth });
    const loops: OpenLoop[] = [];

    // Fetch recent inbox messages (last 48h)
    const listRes = await gmailApi.users.messages.list({
      userId: 'me',
      q: 'newer_than:2d in:inbox',
      maxResults: 200,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) return [];

    // Group by thread — we only need the latest message per thread
    const threadLatest = new Map<string, string>();
    for (const msg of messages) {
      if (msg.threadId && msg.id) {
        if (!threadLatest.has(msg.threadId)) {
          threadLatest.set(msg.threadId, msg.id);
        }
      }
    }

    // Concurrent fetches in batches
    const entries = Array.from(threadLatest.entries());

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(([threadId, messageId]) =>
          this.fetchAndClassify(gmailApi, threadId, messageId, myEmail)
        )
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          loops.push(r.value);
        }
      }
    }

    return loops;
  }

  private async fetchAndClassify(
    gmailApi: gmail_v1.Gmail,
    threadId: string,
    messageId: string,
    myEmail: string,
  ): Promise<OpenLoop | null> {
    const msgRes = await gmailApi.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: [
        'From', 'To', 'Cc', 'Subject', 'Date',
        'List-Unsubscribe', 'Precedence',
        'X-SG-EID', 'X-Mailgun-Tag', 'X-CampaignID', 'Feedback-ID',
        'Auto-Submitted',
      ],
    });

    const payload = msgRes.data.payload;
    if (!payload?.headers) return null;

    // Build headers map (lowercase keys)
    const headers: Record<string, string> = {};
    for (const h of payload.headers) {
      if (h.name && h.value) {
        headers[h.name.toLowerCase()] = h.value;
      }
    }

    const sender = headers['from'] || '';
    const subject = headers['subject'] || '(no subject)';
    const dateStr = headers['date'] || '';

    // Filter: mass email / newsletter
    if (isMassEmail(headers, sender)) return null;

    // Filter: did I send this? (I already replied)
    const senderEmail = extractEmail(sender).toLowerCase();
    const myEmailLower = myEmail.toLowerCase();
    if (senderEmail === myEmailLower) return null;

    // Determine To vs CC tier
    const toHeader = (headers['to'] || '').toLowerCase();
    const isDirectlyAddressed = toHeader.includes(myEmailLower);
    const type = isDirectlyAddressed ? 'gmail.unreplied' : 'gmail.cc';

    const detectedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
    const ageSeconds = (Date.now() - new Date(detectedAt).getTime()) / 1000;

    return {
      source_ref: `${type}:${threadId}`,
      type,
      title: subject,
      source_platform: 'gmail',
      source_channel: undefined,
      source_url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      who_waiting: extractSenderName(sender),
      detected_at: detectedAt,
      urgency: computeUrgency(type, ageSeconds),
      metadata: {
        thread_id: threadId,
        sender,
        sender_email: senderEmail,
        cc_only: !isDirectlyAddressed,
      },
    };
  }
}

function extractEmail(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return match ? match[1] : sender;
}

function extractSenderName(sender: string): string {
  const match = sender.match(/^([^<]+)</);
  if (match) return match[1].trim().replace(/^"|"$/g, '');
  return sender;
}
