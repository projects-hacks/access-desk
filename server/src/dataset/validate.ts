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
  if (shortWire && total(open('ORG-90391', '2026-01')) - shortWire.amountCents !== 2500) problems.push('short wire is not $25.00 short');

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
  return problems;
}
