const COMMITMENT_SIGNALS = [
  /\bi'?ll\b/i,
  /\bi\s+will\b/i,
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|end\s+of|next\s+week)\b/i,
  /\bdeadline\b/i,
  /\bi\s+can\s+do\b/i,
  /\blet\s+me\b/i,
  /\bi'?ve?\s+got\s+(it|this|that)\b/i,
  /\bon\s+it\b/i,
  /\bi'?ll\s+handle\b/i,
  /\bi'?ll\s+take\s+care\b/i,
  /\bpromise\b/i,
  /\bcommit\b/i,
  /\bsure[,.]?\s+i\b/i,
  /\bwill\s+do\b/i,
  /\bgot\s+it[.!]?\s*$/im,
  /\bcount\s+on\s+me\b/i,
  /\bleave\s+it\s+(to|with)\s+me\b/i,
];

export function mightContainCommitment(text: string): boolean {
  return COMMITMENT_SIGNALS.some(pattern => pattern.test(text));
}
