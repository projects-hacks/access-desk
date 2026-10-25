import { addDays, type Ctx } from './context';

const SHARE = 'share_needing_human';
const AUTO = 'handled_automatically';
/** Days a point covers: a business week holds few decisions, so one busy week would swing it. */
const WINDOW_DAYS = 28;

/**
 * The desk's learning curve, from its own audit log: each business week, the share of decisions
 * over the last four weeks that needed a person (proposed for approval) rather than applying on
 * their own. Weeks run on from the last recorded week; a clock that jumped ahead catches up.
 * Points recorded live are recomputed together, so the line always uses one definition.
 */
export function recordWeeklyAutonomy(ctx: Ctx, today: string) {
  let last = '';
  for (const m of ctx.db.metricSnapshot.metric.filter(SHARE)) if (m.weekEnding > last) last = m.weekEnding;
  if (!last) return;
  const weeks: string[] = [];
  for (let end = addDays(last, 7); end < today; end = addDays(end, 7)) weeks.push(end);
  if (!weeks.length) return;

  // Decisions by business day, from the audit log (which starts when the platform went live).
  const byDay = new Map<string, { auto: number; person: number }>();
  let start = '';
  for (const e of ctx.db.auditEvent.iter()) {
    if (!start || e.simDate < start) start = e.simDate;
    if (e.action !== 'AUTO_APPLIED' && e.action !== 'PROPOSE') continue;
    const d = byDay.get(e.simDate) ?? { auto: 0, person: 0 };
    if (e.action === 'AUTO_APPLIED') d.auto++;
    else d.person++;
    byDay.set(e.simDate, d);
  }
  const shareTo = (end: string) => {
    let auto = 0;
    let person = 0;
    for (const [day, d] of byDay) {
      if (day > end || day <= addDays(end, -WINDOW_DAYS)) continue;
      auto += d.auto;
      person += d.person;
    }
    return auto + person ? Math.round((person / (auto + person)) * 1000) / 10 : undefined;
  };

  const put = (end: string, share: number) => {
    for (const [metric, value] of [[SHARE, share], [AUTO, Math.round((100 - share) * 10) / 10]] as const) {
      const id = `${end}:${metric}`;
      const row = { id, weekEnding: end, metric, value };
      if (ctx.db.metricSnapshot.id.find(id)) ctx.db.metricSnapshot.id.update(row);
      else ctx.db.metricSnapshot.insert(row);
    }
  };
  // Live points (after the platform went live) are recomputed; imported history is left as it was.
  const live = [...ctx.db.metricSnapshot.metric.filter(SHARE)].filter((m) => m.weekEnding > start).map((m) => m.weekEnding);
  let previous = [...ctx.db.metricSnapshot.metric.filter(SHARE)].filter((m) => m.weekEnding <= start).sort((a, b) => a.weekEnding.localeCompare(b.weekEnding)).at(-1)?.value ?? 0;
  for (const end of [...new Set([...live, ...weeks])].sort()) {
    const share = shareTo(end) ?? previous;
    previous = share;
    put(end, share);
  }
}
