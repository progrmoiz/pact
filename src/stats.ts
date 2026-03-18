import { getDb } from './db.js';
import chalk from 'chalk';
import Table from 'cli-table3';

export interface PersonStats {
  who_id: string;
  who_name: string;
  total: number;
  delivered: number;
  cancelled: number;
  active: number;
  overdue: number;
  on_time: number;
  avg_days_delta: number; // negative = early, positive = late
  score: number; // 0-5
}

export interface DigestData {
  period: string;
  start: string;
  end: string;
  made: number;
  delivered: number;
  cancelled: number;
  overdue: number;
  active: number;
  by_source: Record<string, number>;
  top_deliverer: { name: string; delivered: number; total: number } | null;
  biggest_slip: { name: string; what: string; days_overdue: number } | null;
}

export function getPersonStats(who?: string): PersonStats[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      c.who_id,
      i.display_name as who_name,
      COUNT(*) as total,
      SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN c.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN c.status = 'active' AND c.deadline IS NOT NULL AND c.deadline < datetime('now') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN c.status = 'done' AND c.deadline IS NOT NULL AND c.resolved_at IS NOT NULL AND c.resolved_at <= c.deadline THEN 1 ELSE 0 END) as on_time,
      AVG(CASE WHEN c.status = 'done' AND c.deadline IS NOT NULL AND c.resolved_at IS NOT NULL
        THEN julianday(c.resolved_at) - julianday(c.deadline) ELSE NULL END) as avg_days_delta
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    ${who ? 'WHERE i.display_name LIKE ?' : ''}
    GROUP BY c.who_id
    ORDER BY total DESC
  `).all(...(who ? [`%${who}%`] : [])) as Array<PersonStats & { avg_days_delta: number | null }>;

  return rows.map(r => {
    const deliveryRate = r.total > 0 ? r.delivered / r.total : 0;
    const onTimeRate = r.delivered > 0 ? r.on_time / r.delivered : 0;
    // Score: 0-5 based on delivery rate (60%) and on-time rate (40%)
    const score = Math.round((deliveryRate * 0.6 + onTimeRate * 0.4) * 5);
    return {
      ...r,
      avg_days_delta: r.avg_days_delta ?? 0,
      score,
    };
  });
}

export function formatStats(stats: PersonStats[]): string {
  if (stats.length === 0) return chalk.dim('No commitments found.');

  const table = new Table({
    head: [
      chalk.bold('Person'),
      chalk.bold('Total'),
      chalk.bold('Delivered'),
      chalk.bold('On Time'),
      chalk.bold('Avg Days'),
      chalk.bold('Score'),
    ],
    colWidths: [16, 8, 14, 12, 12, 10],
  });

  for (const s of stats) {
    const pct = s.total > 0 ? Math.round(s.delivered / s.total * 100) : 0;
    const delta = s.avg_days_delta;
    const deltaStr = delta === 0 ? '—'
      : delta < 0 ? chalk.green(`${Math.abs(delta).toFixed(1)}d early`)
      : chalk.red(`${delta.toFixed(1)}d late`);

    const stars = '★'.repeat(s.score) + '☆'.repeat(5 - s.score);
    const scoreColor = s.score >= 4 ? chalk.green : s.score >= 2 ? chalk.yellow : chalk.red;

    table.push([
      s.who_name,
      String(s.total),
      `${s.delivered} (${pct}%)`,
      s.delivered > 0 ? `${s.on_time}/${s.delivered}` : '—',
      deltaStr,
      scoreColor(stars),
    ]);
  }

  return table.toString();
}

export function formatPersonDetail(stats: PersonStats): string {
  const lines: string[] = [];
  const db = getDb();

  lines.push(chalk.bold(`\n${stats.who_name} — ${stats.total} commitments\n`));

  // By source
  const sources = db.prepare(`
    SELECT source_platform, COUNT(*) as count
    FROM commitments WHERE who_id = ?
    GROUP BY source_platform ORDER BY count DESC
  `).all(stats.who_id) as Array<{ source_platform: string; count: number }>;
  lines.push(`  By source:  ${sources.map(s => `${s.source_platform} (${s.count})`).join(', ')}`);

  // By status
  lines.push(`  By status:  Done (${stats.delivered}), Active (${stats.active}), Overdue (${stats.overdue}), Cancelled (${stats.cancelled})`);

  // On time
  const onTimePct = stats.delivered > 0 ? Math.round(stats.on_time / stats.delivered * 100) : 0;
  lines.push(`  On time:    ${onTimePct}%`);

  // Avg delivery
  const delta = stats.avg_days_delta;
  if (delta !== 0) {
    lines.push(`  Avg delivery: ${Math.abs(delta).toFixed(1)} days ${delta < 0 ? 'before' : 'after'} deadline`);
  }

  // Recent commitments
  const recent = db.prepare(`
    SELECT c.what, c.status, c.deadline, c.resolved_at
    FROM commitments c WHERE c.who_id = ?
    ORDER BY c.created_at DESC LIMIT 5
  `).all(stats.who_id) as Array<{ what: string; status: string; deadline: string | null; resolved_at: string | null }>;

  if (recent.length > 0) {
    lines.push(`\n  Recent:`);
    for (const r of recent) {
      if (r.status === 'done' && r.deadline && r.resolved_at) {
        const days = Math.round((new Date(r.resolved_at).getTime() - new Date(r.deadline).getTime()) / 86400000);
        const timing = days <= 0 ? chalk.green(`${Math.abs(days)}d early`) : chalk.red(`${days}d late`);
        lines.push(`    ${chalk.green('✔')} "${r.what}" — delivered ${timing}`);
      } else if (r.status === 'active' && r.deadline && new Date(r.deadline) < new Date()) {
        const days = Math.round((Date.now() - new Date(r.deadline).getTime()) / 86400000);
        lines.push(`    ${chalk.red('⚠')} "${r.what}" — overdue by ${days}d`);
      } else if (r.status === 'active') {
        lines.push(`    ${chalk.blue('○')} "${r.what}" — active`);
      } else {
        lines.push(`    ${chalk.dim('✗')} "${r.what}" — ${r.status}`);
      }
    }
  }

  return lines.join('\n');
}

export function getDigest(period: 'day' | 'week' | 'month'): DigestData {
  const db = getDb();
  const now = new Date();
  let start: Date;

  if (period === 'day') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start = new Date(now);
    start.setDate(start.getDate() - start.getDay()); // Sunday
    start.setHours(0, 0, 0, 0);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const counts = db.prepare(`
    SELECT
      COUNT(*) as made,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
    FROM commitments WHERE created_at >= ?
  `).get(startIso) as { made: number; delivered: number; cancelled: number; overdue: number; active: number };

  const sources = db.prepare(`
    SELECT source_platform, COUNT(*) as count
    FROM commitments WHERE created_at >= ?
    GROUP BY source_platform ORDER BY count DESC
  `).all(startIso) as Array<{ source_platform: string; count: number }>;

  const bySource: Record<string, number> = {};
  for (const s of sources) bySource[s.source_platform] = s.count;

  // Top deliverer
  const topRow = db.prepare(`
    SELECT i.display_name as name, COUNT(*) as delivered,
      (SELECT COUNT(*) FROM commitments c2 WHERE c2.who_id = c.who_id AND c2.created_at >= ?) as total
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    WHERE c.status = 'done' AND c.resolved_at >= ?
    GROUP BY c.who_id ORDER BY delivered DESC LIMIT 1
  `).get(startIso, startIso) as { name: string; delivered: number; total: number } | undefined;

  // Biggest slip
  const slipRow = db.prepare(`
    SELECT i.display_name as name, c.what,
      CAST(julianday('now') - julianday(c.deadline) AS INTEGER) as days_overdue
    FROM commitments c
    JOIN identities i ON c.who_id = i.id
    WHERE c.status = 'active' AND c.deadline IS NOT NULL AND c.deadline < datetime('now')
      AND c.created_at >= ?
    ORDER BY days_overdue DESC LIMIT 1
  `).get(startIso) as { name: string; what: string; days_overdue: number } | undefined;

  const periodLabel = period === 'day' ? 'Today'
    : period === 'week' ? `This Week (${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
    : `This Month (${start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`;

  return {
    period: periodLabel,
    start: startIso,
    end: endIso,
    ...counts,
    by_source: bySource,
    top_deliverer: topRow || null,
    biggest_slip: slipRow || null,
  };
}

export function formatDigest(data: DigestData): string {
  const lines: string[] = [];
  const deliveredPct = data.made > 0 ? Math.round(data.delivered / data.made * 100) : 0;

  lines.push(chalk.bold(`\n${data.period}\n`));
  lines.push(`  Made:       ${data.made} commitments`);
  lines.push(`  Delivered:  ${data.delivered} (${deliveredPct}%)`);
  lines.push(`  Overdue:    ${data.overdue > 0 ? chalk.red(String(data.overdue)) : '0'}`);
  lines.push(`  Active:     ${data.active}`);
  lines.push(`  Cancelled:  ${data.cancelled}`);

  if (data.top_deliverer) {
    lines.push(`\n  Top deliverer: ${chalk.green(data.top_deliverer.name)} (${data.top_deliverer.delivered}/${data.top_deliverer.total})`);
  }
  if (data.biggest_slip) {
    lines.push(`  Biggest slip:  ${chalk.red(data.biggest_slip.name)} ("${data.biggest_slip.what}" — ${data.biggest_slip.days_overdue}d overdue)`);
  }

  const sourceStr = Object.entries(data.by_source).map(([k, v]) => `${k} (${v})`).join(', ');
  if (sourceStr) lines.push(`\n  Sources: ${sourceStr}`);

  return lines.join('\n');
}
