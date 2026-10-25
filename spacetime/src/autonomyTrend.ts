import { addDays, type Ctx } from './context';

const SHARE = 'share_needing_human';
const AUTO = 'handled_automatically';

/**
 * The desk's learning curve, from its own audit log: each business week, the share of decisions
 * that needed a person (proposed for approval) versus applied on their own. Weeks run on from the
 * last recorded week; a clock that jumped ahead catches up week by week.
 */
export function recordWeeklyAutonomy(ctx: Ctx, today: string) {
  let last = '';
  let previous = 0;
  for (const m of ctx.db.metricSnapshot.metric.filter(SHARE)) {
    if (m.weekEnding > last) {
      last = m.weekEnding;
      previous = m.value;
    }
  }
  if (!last) return;
  for (let end = addDays(last, 7); end < today; last = end, end = addDays(end, 7)) {
    let auto = 0;
    let person = 0;
    for (const e of ctx.db.auditEvent.iter()) {
      if (e.simDate <= last || e.simDate > end) continue;
      if (e.action === 'AUTO_APPLIED') auto++;
      else if (e.action === 'PROPOSE') person++;
    }
    // A week with no decisions keeps the last share, so the line doesn't drop to zero.
    const share = auto + person ? Math.round((person / (auto + person)) * 1000) / 10 : previous;
    previous = share;
    ctx.db.metricSnapshot.insert({ id: `${end}:${SHARE}`, weekEnding: end, metric: SHARE, value: share });
    ctx.db.metricSnapshot.insert({ id: `${end}:${AUTO}`, weekEnding: end, metric: AUTO, value: Math.round((100 - share) * 10) / 10 });
  }
}
