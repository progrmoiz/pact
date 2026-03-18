import { detectSlackTokens } from './types.js';
import { SlackPoller } from './poller.js';
import { SlackListener } from './listener.js';

export { detectSlackTokens, getSlackSendToken } from './types.js';
export type { SlackMode, SlackTokens, SlackIngestionStrategy } from './types.js';

/**
 * Start the Slack adapter. Auto-detects mode from env vars:
 *
 * Solo mode (invisible polling):
 *   PACT_SLACK_USER_TOKEN=xoxp-...
 *
 * Team mode (real-time events via Socket Mode):
 *   PACT_SLACK_BOT_TOKEN=xoxb-...
 *   PACT_SLACK_APP_TOKEN=xapp-...
 */
export async function startSlackAdapter(): Promise<void> {
  const tokens = detectSlackTokens();

  if (!tokens) {
    console.error(
      'No Slack tokens found. Set one of:\n' +
      '  PACT_SLACK_USER_TOKEN=xoxp-...  (solo mode — invisible polling)\n' +
      '  PACT_SLACK_BOT_TOKEN=xoxb-... + PACT_SLACK_APP_TOKEN=xapp-...  (team mode — real-time events)'
    );
    process.exit(1);
  }

  if (tokens.mode === 'team' && tokens.botToken && tokens.appToken) {
    const listener = new SlackListener(tokens.botToken, tokens.appToken);
    await listener.start(async () => {}); // onBatch handled internally via startBatchTimer
  } else {
    const token = tokens.userToken || tokens.botToken!;
    const poller = new SlackPoller(token);
    await poller.start(async () => {}); // onBatch handled internally via startBatchTimer
  }
}
