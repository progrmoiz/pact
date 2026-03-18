import type { App } from '@slack/bolt';
import type { NudgeCandidate } from '../types.js';
import { resolveCommitment, snoozeCommitment } from '../mutations.js';
import { getSlackSendToken } from '../adapters/slack/types.js';

export async function sendSlackDM(
  candidate: NudgeCandidate,
  message: string
): Promise<void> {
  if (!candidate.who_slack_id) {
    console.warn(`No Slack ID for ${candidate.who_name}, skipping DM`);
    return;
  }

  const sendToken = getSlackSendToken();
  if (!sendToken) {
    console.error('No Slack token available for sending DMs. Set PACT_SLACK_BOT_TOKEN or PACT_SLACK_USER_TOKEN.');
    return;
  }

  const { WebClient } = await import('@slack/web-api');
  const client = new WebClient(sendToken.token);

  // Open DM channel
  const dm = await client.conversations.open({ users: candidate.who_slack_id });
  if (!dm.channel?.id) {
    console.warn(`Could not open DM with ${candidate.who_name}`);
    return;
  }

  // Bot token: send with interactive buttons (Bolt app handles clicks)
  // User token: send plain text only (no Bolt app = buttons are dead)
  if (sendToken.isBot) {
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: message,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: message },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Done' },
              style: 'primary',
              action_id: `pact_done_${candidate.id}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Snooze 3d' },
              action_id: `pact_snooze_${candidate.id}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              style: 'danger',
              action_id: `pact_cancel_${candidate.id}`,
            },
          ],
        },
      ],
    });
  } else {
    // User token: plain text, no buttons
    // Append CLI instructions since buttons won't work
    const withInstructions = `${message}\n\n_Resolve via CLI: \`pact resolve ${candidate.id.substring(0, 8)}\` or \`pact snooze ${candidate.id.substring(0, 8)} --days 3\`_`;
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: withInstructions,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: withInstructions },
        },
      ],
    });
  }
}

export function registerSlackActions(app: App): void {
  // Match any action that starts with pact_
  app.action(/^pact_(done|snooze|cancel)_/, async ({ action, ack, respond }) => {
    await ack();

    const actionId = 'action_id' in action ? action.action_id : '';
    const match = actionId.match(/^pact_(done|snooze|cancel)_(.+)$/);
    if (!match) return;

    const [, actionType, commitmentId] = match;

    try {
      if (actionType === 'done') {
        resolveCommitment(commitmentId, 'done');
        await respond({ text: `Marked as done. Nice work.`, replace_original: true });
      } else if (actionType === 'snooze') {
        const newDeadline = new Date();
        newDeadline.setDate(newDeadline.getDate() + 3);
        newDeadline.setHours(17, 0, 0, 0);
        snoozeCommitment(commitmentId, newDeadline.toISOString());
        await respond({ text: `Snoozed for 3 days. New deadline: ${newDeadline.toISOString().split('T')[0]}`, replace_original: true });
      } else if (actionType === 'cancel') {
        resolveCommitment(commitmentId, 'cancelled');
        await respond({ text: `Cancelled.`, replace_original: true });
      }
    } catch (err) {
      await respond({ text: `Error: ${(err as Error).message}`, replace_original: false });
    }
  });
}
