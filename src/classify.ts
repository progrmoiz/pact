import Anthropic from '@anthropic-ai/sdk';

/**
 * Hybrid reply classification — regex + LLM.
 * Stage 1: Regex kills obvious conversation closers (zero cost).
 * Stage 2: LLM classifies ambiguous messages (~$0.001/call).
 */

const CLOSER_PATTERNS = [
  /^(thanks|thank you|thx|ty|thankyou)[!.\s,:]*$/i,
  /^(noted|got it|will do|on it|sounds good|perfect|great|awesome)[!.\s,:]*$/i,
  /^(done|done!|appreciate it|understood|roger|ack|acknowledged)[!.\s,:]*$/i,
  /^(ok|okay|k|kk|yep|yup|yes|yeah|ya|sure|cool|nice|sweet)[!.\s,:]*$/i,
  /^(no worries|no problem|np|nw|all good|all set)[!.\s,:]*$/i,
  /^(👍|✅|🙏|💯|🎉|👏|😊|🤝|💪|❤️|🔥|✨|👌|🫡|😄)+\s*$/,
  /^(lol|lmao|haha|😂|🤣)+\s*$/i,
];

/**
 * Stage 1: Regex fast-kill.
 * Returns true only if: short message + matches closer + no question mark.
 */
export function isObviousCloser(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes('?')) return false;
  if (trimmed.length > 50) return false;
  return CLOSER_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Stage 2: LLM classification for ambiguous messages.
 * Returns true if the message expects a reply, false if it's a conversation closer.
 * Gracefully returns true (assume expects reply) on any error.
 */
export async function classifyExpectsReply(text: string): Promise<boolean> {
  const apiKey = process.env.PACT_LLM_API_KEY;
  if (!apiKey) return true; // No key = assume expects reply (safe default)

  const model = process.env.PACT_LLM_MODEL || 'claude-haiku-4-5-20251001';
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 16,
      temperature: 0,
      system: `You classify Slack messages. Does this message expect a reply from the recipient, or is it a conversation closer (thanks, acknowledgment, sign-off)?

Reply with ONLY one word: "reply" or "closer"

Examples of closers: "thanks!", "noted", "got it", "will do", "appreciate it", "sounds good", "done!", "awesome thank you"
Examples needing reply: "can you check this?", "what do you think?", "LP if you can look this week", "hey any update on X?", "I noticed a bug in..."`,
      messages: [{ role: 'user', content: text.substring(0, 500) }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return true;

    return !content.text.toLowerCase().trim().includes('closer');
  } catch {
    return true; // On error, assume expects reply (safe default)
  }
}
