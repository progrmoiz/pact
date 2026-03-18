import { getNudgeCandidates } from './queries.js';
import { incrementNudge, markEscalated } from './mutations.js';
import { parseDuration } from './utils.js';
import { sendStdoutNudge } from './outputs/stdout.js';
import type { FollowUpConfig, NudgeCandidate } from './types.js';

function formatNudgeMessage(candidate: NudgeCandidate): string {
  const daysOverdue = Math.ceil(
    (Date.now() - new Date(candidate.deadline).getTime()) / 86400000
  );

  if (candidate.nudge_count === 0) {
    return `Hey ${candidate.who_name} -- "${candidate.what}" was due ${daysOverdue} day(s) ago. Still on it?`;
  } else if (candidate.nudge_count === 1) {
    return `Reminder: "${candidate.what}" is now ${daysOverdue} day(s) overdue. Need to reschedule or hand off?`;
  } else {
    return `Final nudge: "${candidate.what}" -- ${daysOverdue} day(s) overdue, nudged ${candidate.nudge_count} times. Escalating if no response.`;
  }
}

export async function runFollowUp(config: FollowUpConfig): Promise<{ nudged: number; escalated: number }> {
  const graceMs = parseDuration(config.gracePeriod);
  const cooldownMs = parseDuration(config.cooldown);

  const candidates = getNudgeCandidates(graceMs, cooldownMs, config.maxNudges);

  let nudged = 0;
  let escalated = 0;

  for (const candidate of candidates) {
    const message = formatNudgeMessage(candidate);

    if (config.dryRun) {
      console.log(`[DRY RUN] Would nudge: ${message}`);
      nudged++;
      continue;
    }

    if (config.via === 'stdout') {
      sendStdoutNudge(candidate, message);
    } else if (config.via === 'slack-dm') {
      const botToken = process.env.PACT_SLACK_BOT_TOKEN;
      if (!botToken) {
        console.error('PACT_SLACK_BOT_TOKEN not set. Cannot send Slack DMs.');
        process.exit(1);
      }
      const { sendSlackDM } = await import('./outputs/slack-dm.js');
      await sendSlackDM(botToken, candidate, message);
    }

    incrementNudge(candidate.id);
    nudged++;

    // Check for escalation
    const newNudgeCount = candidate.nudge_count + 1;
    if (config.escalateAfter && newNudgeCount >= config.escalateAfter) {
      markEscalated(candidate.id);
      escalated++;

      if (config.escalateTo && config.via === 'stdout') {
        console.log(`ESCALATED: "${candidate.what}" (${candidate.who_name}) → ${config.escalateTo}`);
      }
    }
  }

  return { nudged, escalated };
}
