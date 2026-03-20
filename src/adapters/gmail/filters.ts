/**
 * Header-based newsletter / mass email detection.
 * Zero LLM cost — kills 60%+ of emails before processing.
 *
 * Ported from Fergana-Labs/scheduled newsletter.py.
 */

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

const MARKETING_HEADERS = new Set([
  'x-sg-eid',
  'x-mailgun-tag',
  'x-campaignid',
  'feedback-id',
]);

const AUTO_SUBMITTED_SKIP = new Set(['auto-generated', 'auto-replied']);

const NOREPLY_PATTERN = /^(noreply|no-reply|no\.reply|newsletter|marketing|notifications|updates|digest|bounce|orders|support|info|donotreply|do-not-reply|mailer|alert|alerts|billing|receipts|invoices)/i;

function extractEmail(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return match ? match[1] : sender;
}

export function isMassEmail(headers: Record<string, string>, sender: string): boolean {
  // List-Unsubscribe header
  if ('list-unsubscribe' in headers) return true;

  // Precedence: bulk / list / junk
  const precedence = (headers['precedence'] || '').toLowerCase().trim();
  if (BULK_PRECEDENCE.has(precedence)) return true;

  // Marketing platform headers
  for (const h of MARKETING_HEADERS) {
    if (h in headers) return true;
  }

  // Auto-submitted
  const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase().trim();
  if (AUTO_SUBMITTED_SKIP.has(autoSubmitted)) return true;

  // Sender patterns
  const addr = extractEmail(sender).toLowerCase();
  if (NOREPLY_PATTERN.test(addr)) return true;

  return false;
}
