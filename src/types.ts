export interface Commitment {
  id: string;
  who_id: string;
  who_name?: string;
  to_whom_id: string | null;
  to_whom_name?: string;
  what: string;
  raw_text: string;
  deadline: string | null;
  confidence: number;
  status: 'active' | 'done' | 'cancelled';
  source_platform: string;
  source_channel: string | null;
  source_message_id: string | null;
  source_url: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  nudge_count: number;
  last_nudged_at: string | null;
  escalated: number;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Identity {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface IdentityAlias {
  identity_id: string;
  platform: string;
  handle: string;
  created_at: string;
}

export interface ExtractionResult {
  who: string | null;
  what: string;
  to_whom: string | null;
  deadline: string | null;
  confidence: number;
}

export interface ListFilters {
  status?: string;
  who?: string;
  overdue?: boolean;
  source?: string;
  channel?: string;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
}

export interface AdapterOutput {
  text: string;
  source: {
    platform: string;
    channel?: string;
    messageId?: string;
    timestamp: string;
    url?: string;
  };
  participants: string[];
}

export interface FollowUpConfig {
  via: 'slack-dm' | 'stdout';
  gracePeriod: string;
  maxNudges: number;
  cooldown: string;
  escalateAfter?: number;
  escalateTo?: string;
  dryRun: boolean;
}

export interface NudgeCandidate {
  id: string;
  who_id: string;
  who_name: string;
  who_slack_id: string | null;
  what: string;
  deadline: string;
  nudge_count: number;
  last_nudged_at: string | null;
  escalated: number;
}
