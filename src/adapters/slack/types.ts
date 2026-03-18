import type { MessageBatch } from '../../batcher.js';

/**
 * Strategy interface for Slack ingestion.
 * Two implementations: SlackPoller (user token) and SlackListener (bot token + Socket Mode).
 */
export interface SlackIngestionStrategy {
  start(onBatch: (batches: MessageBatch[]) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface ChannelInfo {
  id: string;
  updated: number;
  type: 'channel' | 'im' | 'mpim';
  userId?: string; // for DMs — the other person's user ID
  name?: string;
}

export interface PollState {
  [channelId: string]: string; // Slack ts format: "1234567890.123456"
}

export type SlackMode = 'solo' | 'team';

export interface SlackTokens {
  mode: SlackMode;
  userToken?: string;  // xoxp- for solo mode
  botToken?: string;   // xoxb- for team mode
  appToken?: string;   // xapp- for Socket Mode (team mode)
}

/**
 * Detect Slack mode from environment variables.
 * Solo: PACT_SLACK_USER_TOKEN (xoxp-) — polling, invisible
 * Team: PACT_SLACK_BOT_TOKEN (xoxb-) + PACT_SLACK_APP_TOKEN (xapp-) — events, visible bot
 */
export function detectSlackTokens(): SlackTokens | null {
  const userToken = process.env.PACT_SLACK_USER_TOKEN;
  const botToken = process.env.PACT_SLACK_BOT_TOKEN;
  const appToken = process.env.PACT_SLACK_APP_TOKEN;

  // Team mode: bot + app token
  if (botToken && appToken) {
    return { mode: 'team', botToken, appToken, userToken };
  }

  // Solo mode: user token only
  if (userToken) {
    return { mode: 'solo', userToken };
  }

  return null;
}

/**
 * Get the best token for sending messages (follow-up DMs).
 * Prefers bot token (messages appear from bot, buttons work).
 * Falls back to user token (messages appear from you, no buttons).
 */
export function getSlackSendToken(): { token: string; isBot: boolean } | null {
  const botToken = process.env.PACT_SLACK_BOT_TOKEN;
  const userToken = process.env.PACT_SLACK_USER_TOKEN;

  if (botToken) {
    return { token: botToken, isBot: true };
  }
  if (userToken) {
    return { token: userToken, isBot: false };
  }
  return null;
}
