import type { OpenLoop, OpenLoopScanner } from '../../types.js';
import { computeUrgency } from '../../open-loops.js';

interface GitHubSearchItem {
  html_url: string;
  number: number;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  repository_url: string;
  pull_request?: { html_url: string };
}

async function ghApi(path: string, token: string): Promise<any> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * GitHub Open Loop Scanner — detects PR reviews and assigned issues.
 * API-only, zero LLM cost. Self-resolving.
 */
export class GitHubScanner implements OpenLoopScanner {
  platform = 'github';
  private token: string;
  private username: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  private async getUsername(): Promise<string> {
    if (this.username) return this.username;
    const user = await ghApi('/user', this.token);
    this.username = user.login as string;
    return this.username!;
  }

  async scan(): Promise<OpenLoop[]> {
    const username = await this.getUsername();
    const loops: OpenLoop[] = [];

    const [prLoops, issueLoops] = await Promise.all([
      this.scanPRReviews(username),
      this.scanAssignedIssues(username),
    ]);

    loops.push(...prLoops);
    loops.push(...issueLoops);

    return loops;
  }

  /**
   * Find PRs where your review is requested.
   */
  private async scanPRReviews(username: string): Promise<OpenLoop[]> {
    const loops: OpenLoop[] = [];

    try {
      const result = await ghApi(
        `/search/issues?q=type:pr+review-requested:${username}+is:open&sort=updated&order=desc&per_page=50`,
        this.token
      );

      for (const pr of (result.items || []) as GitHubSearchItem[]) {
        const repo = pr.repository_url.split('/').slice(-2).join('/');
        const ageMs = Date.now() - new Date(pr.created_at).getTime();
        const ageSeconds = Math.floor(ageMs / 1000);

        loops.push({
          source_ref: `github.pr-review:${repo}:${pr.number}`,
          type: 'github.pr-review',
          title: `Review: ${pr.title}`,
          source_platform: 'github',
          source_channel: repo,
          source_url: pr.html_url,
          who_waiting: pr.user.login,
          detected_at: pr.created_at,
          urgency: computeUrgency('github.pr-review', ageSeconds),
          metadata: {
            repo,
            pr_number: pr.number,
            author: pr.user.login,
            updated_at: pr.updated_at,
          },
        });
      }
    } catch (err) {
      console.warn(`GitHub PR review scan failed: ${(err as Error).message}`);
    }

    return loops;
  }

  /**
   * Find issues assigned to you.
   */
  private async scanAssignedIssues(username: string): Promise<OpenLoop[]> {
    const loops: OpenLoop[] = [];

    try {
      const result = await ghApi(
        `/search/issues?q=type:issue+assignee:${username}+is:open&sort=updated&order=desc&per_page=50`,
        this.token
      );

      for (const issue of (result.items || []) as GitHubSearchItem[]) {
        const repo = issue.repository_url.split('/').slice(-2).join('/');
        const ageMs = Date.now() - new Date(issue.created_at).getTime();
        const ageSeconds = Math.floor(ageMs / 1000);

        loops.push({
          source_ref: `github.issue:${repo}:${issue.number}`,
          type: 'github.issue',
          title: issue.title,
          source_platform: 'github',
          source_channel: repo,
          source_url: issue.html_url,
          who_waiting: issue.user.login,
          detected_at: issue.created_at,
          urgency: computeUrgency('github.issue', ageSeconds),
          metadata: {
            repo,
            issue_number: issue.number,
            author: issue.user.login,
            updated_at: issue.updated_at,
          },
        });
      }
    } catch (err) {
      console.warn(`GitHub issue scan failed: ${(err as Error).message}`);
    }

    return loops;
  }
}
