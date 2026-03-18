import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { getPromptPath, getWhoami } from './utils.js';
import type { ExtractionResult } from './types.js';

export interface ExtractionContext {
  participants?: string[];  // Names of people in the conversation
  channel?: string;         // Channel name for context
}

export async function extractCommitments(text: string, context?: ExtractionContext): Promise<ExtractionResult[]> {
  const apiKey = process.env.PACT_LLM_API_KEY;
  if (!apiKey) {
    throw new Error('PACT_LLM_API_KEY not set. Get one at https://console.anthropic.com/');
  }

  const model = process.env.PACT_LLM_MODEL || 'claude-haiku-4-5-20251001';
  const promptTemplate = readFileSync(getPromptPath(), 'utf-8');

  const currentDate = new Date().toISOString().split('T')[0];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const whoami = getWhoami() || 'Unknown';

  let systemPrompt = promptTemplate
    .replace(/\{\{CURRENT_DATE\}\}/g, currentDate)
    .replace(/\{\{CURRENT_TIMEZONE\}\}/g, timezone)
    .replace(/\{\{PACT_USER\}\}/g, whoami)
    .replace(/\{\{PARTICIPANTS\}\}/g, context?.participants?.join(', ') || 'Unknown')
    .replace(/\{\{CHANNEL\}\}/g, context?.channel || 'stdin');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }],
  });

  const content = response.content[0];
  if (content.type !== 'text') return [];

  try {
    const parsed = JSON.parse(content.text);
    const commitments: ExtractionResult[] = parsed.commitments || [];
    return commitments.filter(c => c.confidence >= 0.7);
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = content.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      const commitments: ExtractionResult[] = parsed.commitments || [];
      return commitments.filter(c => c.confidence >= 0.7);
    }
    throw new Error(`Failed to parse LLM response: ${content.text.substring(0, 200)}`);
  }
}
