import { addDays } from './dates';
import type { Dataset } from './types';

/** Invariants the demo depends on. Returns a list of problems; empty means consistent. */
export function validateDataset(ds: Dataset): string[] {
  const problems: string[] = [];
  const invoices = new Map(ds.invoices.map((i) => [i.id, i]));
  const clients = new Set(ds.clients.map((c) => c.id));
  const affiliates = new Map(ds.affiliates.map((a) => [a.key, a]));
  const loans = new Map(ds.loans.map((l) => [l.id, l]));

  const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of dupes(ds.invoices.map((i) => i.id))) problems.push(`duplicate invoice id ${id}`);
  for (const id of dupes(ds.movements.map((m) => m.id))) problems.push(`duplicate movement id ${id}`);

  for (const inv of ds.invoices) {
    if (!clients.has(inv.clientId)) problems.push(`${inv.id}: unknown client ${inv.clientId}`);
    if (!Number.isInteger(inv.amountCents) || inv.amountCents <= 0) problems.push(`${inv.id}: bad amount`);
    if (inv.paidCents > inv.amountCents) problems.push(`${inv.id}: paid more than billed`);
  }

  const payerClient = (m: Dataset['movements'][number]) =>
    m.party?.type === 'client' ? m.party.id : m.party ? affiliates.get(m.party.key)?.parentId : undefined;

  for (const m of ds.movements) {
    if (!Number.isInteger(m.amountCents) || m.amountCents <= 0) problems.push(`${m.id}: bad amount`);
    if (m.party?.type === 'affiliate' && !affiliates.has(m.party.key)) problems.push(`${m.id}: unknown affiliate`);
    if (m.party?.type === 'client' && !clients.has(m.party.id)) problems.push(`${m.id}: unknown client`);
    const future = m.valueDate > ds.simDate;
    if (future && m.caseId !== 'demo-affiliate-wire') problems.push(`${m.id}: dated after sim date`);
    if (m.valueDate < ds.bankWindowStart) problems.push(`${m.id}: before bank window`);

    const owner = payerClient(m);
    for (const ref of m.refs) {
      if (ref.startsWith('INV-')) {
        const inv = invoices.get(ref);
        if (!inv) problems.push(`${m.id}: ref ${ref} does not exist`);
        else if (inv.clientId !== owner) problems.push(`${m.id}: ref ${ref} belongs to ${inv.clientId}, payer is ${owner}`);
      } else if (ref.startsWith('ORG-')) {
        if (ref !== owner) problems.push(`${m.id}: client ref ${ref} but payer is ${owner}`);
      } else if (ref.startsWith('LN-')) {
        if (loans.get(ref)?.clientId !== owner) problems.push(`${m.id}: loan ref ${ref} not owned by payer`);
      }
    }
  }

  // Story checks: the numbers the demo narrates must line up.
  const open = (clientId: string, period: string) =>
    ds.invoices.filter((i) => i.clientId === clientId && i.period === period && i.status === 'open');
  const total = (list: { amountCents: number }[]) => list.reduce((s, x) => s + x.amountCents, 0);

  const zephyr = ds.movements.find((m) => m.caseId === 'demo-affiliate-wire');
  if (zephyr?.amountCents !== total(open('ORG-90412', '2026-01'))) problems.push('Zephyr wire != Kestrel open January total');
  if (zephyr?.amountCents !== 14_820_000) problems.push('Zephyr wire is not $148,200.00');

  const shortWire = ds.movements.find((m) => m.caseId === 'short-wire');
  const shortClient = ds.cases.find((k) => k.id === 'short-wire')!.clientId;
  if (shortWire && total(open(shortClient, '2026-01')) - shortWire.amountCents !== 2500) problems.push('short wire is not $25.00 short');
  if (shortWire && (shortWire.instructedCents! - shortWire.chargesCents! !== shortWire.amountCents)) problems.push('short wire: instructed − charges != received');

  const lump = ds.movements.find((m) => m.caseId === 'lump-sum');
  const fieldstoneOpen = ds.invoices.filter((i) => i.clientId === 'ORG-90229' && i.period !== '2026-02' && i.status === 'open');
  if (lump?.amountCents !== total(fieldstoneOpen)) problems.push('lump sum does not equal the open invoices it covers');

  const inTransit = ds.movements.find((m) => m.caseId === 'in-transit');
  if (inTransit?.status !== 'pending') problems.push('in-transit wire must be pending');

  // Overnight work: cash dated yesterday/today must still be unapplied in billing.
  const overnight = addDays(ds.simDate, -1);
  for (const m of ds.movements.filter((x) => x.kind === 'client_payment' && x.valueDate >= overnight && x.status === 'completed')) {
    for (const ref of m.refs.filter((r) => r.startsWith('INV-'))) {
      if (invoices.get(ref)?.status === 'paid' && m.caseId !== 'wrong-reference') problems.push(`${m.id}: overnight cash but ${ref} already applied`);
    }
  }

  for (const c of ds.cases) if (c.clientId && !clients.has(c.clientId)) problems.push(`case ${c.id}: unknown client`);

  // History: every history invoice is paid, by cash dated before the bank window.
  const historyIds = new Set(ds.history.cash.flatMap((p) => p.refs));
  const paidBy = new Map<string, number>();
  for (const p of ds.history.cash) {
    if (p.valueDate >= ds.bankWindowStart || p.valueDate < ds.history.start) problems.push(`${p.id}: history cash dated ${p.valueDate}`);
    if (!clients.has(p.clientId)) problems.push(`${p.id}: unknown client`);
    for (const ref of p.refs) {
      const inv = invoices.get(ref);
      if (!inv) problems.push(`${p.id}: ref ${ref} missing`);
      else if (inv.clientId !== p.clientId) problems.push(`${p.id}: ref ${ref} belongs to ${inv.clientId}`);
    }
  }
  for (const inv of ds.invoices.filter((i) => historyIds.has(i.id))) {
    if (inv.status !== 'paid' || inv.paidCents !== inv.amountCents || !inv.paidOn) problems.push(`${inv.id}: history invoice not fully paid`);
  }
  // Cash and invoices agree: what the history wires carry equals what billing applied.
  for (const p of ds.history.cash) paidBy.set(p.clientId, (paidBy.get(p.clientId) ?? 0) + p.amountCents);
  for (const [clientId, cents] of paidBy) {
    const applied = ds.invoices.filter((i) => i.clientId === clientId && historyIds.has(i.id)).reduce((s, i) => s + i.paidCents, 0);
    if (applied !== cents) problems.push(`${clientId}: history cash ${cents} != applied ${applied}`);
  }
  // Patterns are really in the data.
  const juniper = ds.invoices.filter((i) => i.clientId === 'ORG-90677' && historyIds.has(i.id));
  if (!juniper.length || juniper.some((i) => i.paidOn !== addDays(i.dueOn, 20))) problems.push('Juniper: history not paid on day 20');
  const kestrelLate = ds.invoices.filter((i) => i.clientId === 'ORG-90412' && ['2025-10', '2025-11', '2025-12'].includes(i.period) && i.paidOn! > i.dueOn);
  if (new Set(kestrelLate.map((i) => i.period)).size !== 3) problems.push('Kestrel: expected 3 late months in the last 90 days');
  // Precedent outcomes match the payments ("paid in 4d").
  for (const prc of ds.history.precedents) {
    if (!clients.has(prc.clientId)) problems.push(`${prc.id}: unknown client`);
    const days = /Paid in (\d+)d/.exec(prc.outcome)?.[1];
    if (days && !ds.history.cash.some((p) => p.clientId === prc.clientId && p.valueDate === addDays(prc.decidedOn, Number(days)))) {
      problems.push(`${prc.id}: no payment ${days} days after ${prc.decidedOn}`);
    }
  }
  return problems;
}
