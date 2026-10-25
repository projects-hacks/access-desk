import { LEVER_WORDS, PROPOSAL_WORDS, clause } from './helpers';
import { listed, plural, usd } from './format';
import type { CapabilityRow, ClientView, PolicyRow } from './model';

/** What a full cutoff of the account would cost, assumed as a share of notional (bps) when positions are force-closed. */
export const UNWIND_COST_BPS = Number(process.env.UNWIND_COST_BPS ?? 50);

/** Restrictions apply under pol-006 without a person, except for Tier 1 and strategic clients. */
export const autoApplies = (v: ClientView, policies: PolicyRow[]) =>
  policies.some((p) => p.policyId === 'pol-006') && v.client.tier > 1 && !v.client.strategic;

/** The proposed step next to what a full cutoff would do, from the client's own data. */
export function cutoffComparison(v: ClientView, lever: string, step: string, owedCents: number, capability: CapabilityRow[], policies: PolicyRow[]) {
  const custody = v.custody.reduce((s, h) => s + h.valueCents, 0);
  const held = lever === 'withdrawals' && step === 'HOLD_AMOUNT_OWED' ? owedCents : 0;
  const inUse = v.levers.filter((l) => l.state !== 'not_used').map((l) => l.lever);
  const positions = v.positions.filter((p) => p.status === 'open');
  const hedges = positions.filter((p) => p.hedgeGroup);
  const notional = positions.reduce((s, p) => s + Math.abs(p.notionalCents), 0);
  const unwind = Math.floor((notional * UNWIND_COST_BPS) / 10_000);
  const twoApprovers = new Set(capability.filter((c) => c.twoApprovers).map((c) => `${c.lever}/${c.step}`));
  const active = new Set(policies.map((p) => p.policyId));

  const noClose = clause(v, 'no_forced_close');
  const breaches = noClose?.allowed && positions.length ? [{ clause: noClose.clause, kind: noClose.kind, text: noClose.text }] : [];
  const broken = ([['pol-006', custody > owedCents], ['pol-008', hedges.length > 0]] as const).filter(([id, applies]) => applies && active.has(id)).map(([id]) => id);

  const kept = inUse.filter((l) => l !== lever).map((l) => LEVER_WORDS[l] ?? l);
  const proposedParts = [
    held ? `Hold ${usd(held)} of withdrawals${custody ? ` (${((held * 100) / custody).toFixed(1)}% of ${usd(custody)} custody)` : ''}` : (PROPOSAL_WORDS[step] ?? step.replace(/_/g, ' ').toLowerCase()),
    kept.length ? `${listed(kept)} unaffected` : 'nothing else changes',
  ];
  if (positions.length) proposedParts.push(`${plural(positions.length, 'open position')} untouched`);
  const cut = inUse.filter((l) => l !== 'withdrawals').map((l) => LEVER_WORDS[l] ?? l);
  const full: string[] = [];
  if (custody) full.push(`freezes all ${usd(custody)} of custody${owedCents ? ` (${Math.round(custody / owedCents).toLocaleString('en-US')}× the ${usd(owedCents)} owed)` : ''}`);
  if (cut.length) full.push(`cuts ${listed(cut)}`);
  if (positions.length) {
    full.push(`force-closes ${plural(positions.length, 'open position')}${hedges.length ? ` incl. ${hedges.length} hedged` : ''} (${usd(notional)} notional, est. ${usd(unwind)} unwind cost at ${UNWIND_COST_BPS} bps)`);
  }
  if (breaches.length || broken.length) full.push(`breaches ${listed([...breaches.map((b) => `§${b.clause} (${b.kind.replace(/_/g, ' ')})`), ...broken])}`);
  full.push('needs two approvers');
  full[0] = full[0]!.charAt(0).toUpperCase() + full[0]!.slice(1);
  return {
    kind: 'cutoff_comparison',
    owedCents,
    assumptions: { unwindCostBps: UNWIND_COST_BPS },
    proposed: {
      lever, step, summary: `${proposedParts.join('; ')}.`,
      custodyFrozenCents: held, leversCut: [], leversOpen: inUse.filter((l) => l !== lever),
      positionsForceClosed: 0, hedgesForceClosed: 0, clausesBreached: [], policiesBreached: [],
      approversNeeded: twoApprovers.has(`${lever}/${step}`) ? 2 : autoApplies(v, policies) ? 0 : 1,
    },
    fullCutoff: {
      summary: `${full.join('; ')}.`,
      custodyFrozenCents: custody, frozenToOwed: owedCents ? Math.round((custody / owedCents) * 10) / 10 : null,
      leversCut: inUse, leversOpen: [],
      positionsForceClosed: positions.length, hedgesForceClosed: hedges.length, notionalCents: notional,
      estimatedUnwindCostCents: unwind, clausesBreached: breaches, policiesBreached: broken,
      approversNeeded: 2,
    },
  };
}

export type CutoffComparison = ReturnType<typeof cutoffComparison>;
