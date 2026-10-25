import type { Dataset, IsoDate } from '../dataset';
import { addDays } from '../dataset/dates';
import { tables, type DbConnection } from '../module_bindings';
import type { ClientView, DisputeView, InvoiceView, RecentAch, RecentWire, WorldSnapshot } from './events';
import type { CureView, Profile } from './personality';
import { isWorldRef } from './refs';

type Db = DbConnection['db'];

/** What the world reads from the shared database. */
export const WORLD_TABLES = [
  tables.clock, tables.invoice, tables.cashMovement, tables.accessLever, tables.custodyHolding, tables.assetPrice,
  tables.deadline, tables.hold, tables.payerIdentity, tables.tradeOrder, tables.accessRequest, tables.dispute,
];

export interface ClockView {
  simDate: IsoDate;
  secondsPerDay: number;
  runUntil?: string;
  updatedAtMs: number;
}

export function readClock(db: Db): ClockView | undefined {
  const c = db.clock.id.find(1);
  return c ? { simDate: c.simDate, secondsPerDay: c.secondsPerDay, runUntil: c.runUntil, updatedAtMs: Number(c.updatedAt.microsSinceUnixEpoch / 1000n) } : undefined;
}

export interface SnapshotOptions {
  /** Invoices a payment was just sent for, before the database shows it. */
  inFlight?: ReadonlySet<string>;
  /** Events already made today (by client), if the database can't show them yet. */
  eventsToday?: ReadonlyMap<string, number>;
}

/** Every bank reference of what the world has sent, as the database shows it. */
export function worldRefs(db: Db): string[] {
  return [...db.cashMovement.iter()].map((m) => m.bankRef).filter(isWorldRef);
}

/**
 * The world as the database shows it right now: what each client owes and when it would pay,
 * what it holds, whether trading and withdrawals are open, and what it did today. Nothing is
 * remembered between calls, so a restarted server sees exactly what the last one left.
 */
export function readSnapshot(db: Db, ds: Dataset, profiles: ReadonlyMap<string, Profile>, opts: SnapshotOptions = {}): { snapshot: WorldSnapshot; clock: ClockView } {
  const clock = readClock(db);
  if (!clock) throw new Error('clock row missing: is the module published?');
  const today = clock.simDate;
  const dayStart = BigInt(clock.updatedAtMs) * 1000n;

  const accountOwner = new Map<string, string>();
  const ownAccount = new Map<string, string>();
  for (const p of db.payerIdentity.iter()) {
    if (p.kind !== 'bank_account') continue;
    accountOwner.set(p.value, p.clientId);
    if (p.id === `${p.clientId}:acct`) ownAccount.set(p.clientId, p.value);
  }

  const invoices = new Map<string, InvoiceView[]>();
  for (const i of db.invoice.iter()) {
    if (i.issuedOn > today || i.paidCents >= i.amountCents) continue;
    const list = invoices.get(i.clientId) ?? [];
    list.push({
      id: i.id, product: i.product, dueOn: i.dueOn, amountCents: Number(i.amountCents), paidCents: Number(i.paidCents),
      disputed: i.status === 'disputed', inFlight: opts.inFlight?.has(i.id) ?? false,
    });
    invoices.set(i.clientId, list);
  }

  const world = [...db.cashMovement.iter()].filter((m) => !m.isHistory);
  for (const m of world) {
    if (m.direction === 'in' && (m.matchStatus === 'unmatched' || m.matchStatus === 'in_transit')) {
      for (const ref of m.refs) for (const v of invoices.get(accountOwner.get(m.origAccount) ?? '') ?? []) if (v.id === ref) v.inFlight = true;
    }
  }
  const returned = new Set(world.filter((m) => m.reverses).map((m) => m.reverses!));
  const mine = world.filter((m) => isWorldRef(m.bankRef));
  const key = (m: (typeof mine)[number]) => `${accountOwner.get(m.origAccount)}|${m.amountCents}|${m.refs.join(',')}`;
  const sent = new Map<string, number>();
  for (const m of mine) if (m.category === 'wire_in' && m.valueOn >= addDays(today, -3)) sent.set(key(m), (sent.get(key(m)) ?? 0) + 1);

  const cures = new Map<string, CureView>();
  for (const d of [...db.deadline.iter()].filter((x) => x.kind === 'cure_period').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (d.status === 'open' || d.status === 'expired') cures.set(d.clientId, { state: d.status === 'open' ? 'running' : 'expired', dueOn: d.dueOn });
    else cures.delete(d.clientId);
  }

  const held = new Map<string, bigint>();
  for (const h of db.hold.iter()) if (h.status === 'active') held.set(h.clientId, (held.get(h.clientId) ?? 0n) + h.amountCents);

  const eventsToday = new Map<string, number>();
  const count = (clientId: string | undefined) => clientId && eventsToday.set(clientId, (eventsToday.get(clientId) ?? 0) + 1);
  for (const m of mine) if (m.valueOn === today) count(accountOwner.get(m.origAccount));
  for (const o of db.tradeOrder.iter()) if (o.at.microsSinceUnixEpoch >= dayStart) count(o.clientId);
  for (const r of db.accessRequest.iter()) if (r.action === 'withdraw' && r.at.microsSinceUnixEpoch >= dayStart) count(r.clientId);
  const underReview = new Map<string, DisputeView[]>();
  for (const d of db.dispute.iter()) {
    if (d.openedOn === today || d.resolvedOn === today) count(d.clientId);
    if (d.status !== 'under_review') continue;
    underReview.set(d.clientId, [...(underReview.get(d.clientId) ?? []), { id: d.id, invoiceId: d.invoiceId, openedOn: d.openedOn, amountCents: Number(d.amountCents) }]);
  }

  const clients: ClientView[] = ds.clients.map((c) => {
    const profile = profiles.get(c.id)!;
    const own = ownAccount.get(c.id);
    const holding = (asset: string) => db.custodyHolding.id.find(`${c.id}:${asset}`);
    const usd = holding('USD')?.valueCents ?? 0n;
    const lever = (name: string) => db.accessLever.id.find(`${c.id}:${name}`)?.state;
    const trading = lever('trading');
    const mineOf = (category: string) => mine.filter((m) => m.category === category && accountOwner.get(m.origAccount) === c.id);
    const unpaidIds = new Set((invoices.get(c.id) ?? []).map((i) => i.id));
    const paid = (ids: string[]) => ids.length > 0 && ids.every((id) => !unpaidIds.has(id));

    const recentWires: RecentWire[] = mineOf('wire_in')
      .filter((m) => m.matchStatus === 'matched' && m.valueOn >= addDays(today, -3))
      .map((m) => ({
        ref: m.bankRef, amountCents: Number(m.amountCents), chargesCents: Number(m.chargesCents ?? 0n), invoiceIds: m.refs.filter((r) => r.startsWith('INV-')),
        remittance: m.remittance, payer: (m.origAccount === own ? 'client' : 'affiliate') as RecentWire['payer'], duplicated: (sent.get(key(m)) ?? 0) > 1,
      }))
      .filter((w) => paid(w.invoiceIds));
    const recentAch: RecentAch[] = mineOf('ach_collection')
      .filter((m) => m.matchStatus === 'matched' && m.valueOn >= addDays(today, -7))
      .map((m) => ({ ref: m.bankRef, amountCents: Number(m.amountCents), invoiceIds: m.refs.filter((r) => r.startsWith('INV-')), returned: returned.has(m.bankRef) }));

    return {
      profile,
      disputes: underReview.get(c.id) ?? [],
      invoices: invoices.get(c.id) ?? [],
      cure: cures.get(c.id),
      usdFreeCents: Number(usd - (held.get(c.id) ?? 0n) > 0n ? usd - (held.get(c.id) ?? 0n) : 0n),
      cryptoCents: { BTC: Number(holding('BTC')?.valueCents ?? 0n), ETH: Number(holding('ETH')?.valueCents ?? 0n) },
      hasTrading: c.products.includes('TRADING'),
      trading: trading === 'active' ? 'open' : trading === 'limited' ? 'limited' : trading === 'off' ? 'off' : 'none',
      withdrawals: lever('withdrawals') === 'off' ? 'frozen' : 'open',
      recentWires,
      recentAch,
      eventsToday: Math.max(eventsToday.get(c.id) ?? 0, opts.eventsToday?.get(c.id) ?? 0),
    };
  });
  return { snapshot: { simDate: today, clients }, clock };
}
