import type { Dataset } from '../dataset';
import { addDays } from '../dataset/dates';
import { holdingsFor, contractFor } from '../dataset/platform-data';
import { invoiceKey, invoicesToIssue } from './billing';
import { applyEvent, chooseEvent, seeded, type ClientView, type InvoiceView, type WorldSnapshot } from './events';
import { deriveProfiles } from './personality';

/**
 * The world without a database: the dataset's open book, billing and the event chooser run for
 * some sim days, paying through `applyEvent` the way the platform would apply a matched wire.
 * Contract time is approximated (a default notice the day after grace, cure period after that) so
 * clients that wait for the cure period have something to wait for. Used by the balance test.
 */
export interface Paid { invoiceId: string; clientId: string; dueOn: string; paidOn: string; amountCents: number; issuedInSim: boolean }

export function simulateBook(ds: Dataset, days: number, seed: number, opts: { eventsPerDay?: number; clientDayCap?: number } = {}) {
  const profiles = deriveProfiles(ds);
  const rng = seeded(seed);
  const eventsPerDay = opts.eventsPerDay ?? 6;
  const open = new Map<string, InvoiceView & { clientId: string; issuedOn: string; issuedInSim: boolean }>();
  for (const i of ds.invoices) {
    if (i.paidCents >= i.amountCents) continue;
    open.set(i.id, { id: i.id, clientId: i.clientId, product: i.product, dueOn: i.dueOn, amountCents: i.amountCents, paidCents: i.paidCents, disputed: i.status === 'disputed', inFlight: false, issuedOn: i.issuedOn, issuedInSim: false });
  }
  const keys = new Set(ds.invoices.map((i) => invoiceKey(i.clientId, i.product, i.period)));
  const ids = ds.invoices.map((i) => i.id);
  const paid: Paid[] = [];
  const kinds: Record<string, number> = {};
  const wires = new Map<string, Array<ClientView['recentWires'][number] & { day: number }>>();
  let day = 0;
  let date = ds.simDate;

  const view = (clientId: string): ClientView => {
    const c = ds.clients.find((x) => x.id === clientId)!;
    const mine = [...open.values()].filter((i) => i.clientId === clientId);
    const { graceDays, cureDays } = contractFor(c);
    const firstLate = mine.filter((i) => !i.disputed && addDays(i.dueOn, graceDays) < date).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
    const cureEnds = firstLate ? addDays(firstLate.dueOn, graceDays + 1 + cureDays) : undefined;
    const holdings = holdingsFor(c);
    const cash = (a: string) => holdings.find((h) => h.asset === a)?.valueCents ?? 0;
    return {
      profile: profiles.get(clientId)!, invoices: mine.map(({ clientId: _c, issuedOn: _o, issuedInSim: _s, ...v }) => v),
      cure: cureEnds ? { state: cureEnds > date ? 'running' : 'expired', dueOn: cureEnds } : undefined,
      usdFreeCents: cash('USD'), cryptoCents: { BTC: cash('BTC'), ETH: cash('ETH') }, hasTrading: c.products.includes('TRADING'),
      trading: c.products.includes('TRADING') ? 'open' : 'none', withdrawals: 'open', recentWires: (wires.get(clientId) ?? []).filter((w) => day - w.day <= 3), recentAch: [], eventsToday: 0,
    };
  };

  let snap: WorldSnapshot | undefined;
  let counts = new Map<string, number>();
  let maxPerClientDay = 0;
  for (day = 0; day < days; day++) {
    date = addDays(ds.simDate, day);
    counts = new Map();
    for (const i of invoicesToIssue(ds, date, { ids, keys })) {
      keys.add(invoiceKey(i.clientId, i.product, i.period));
      ids.push(i.id);
      open.set(i.id, { id: i.id, clientId: i.clientId, product: i.product, dueOn: i.dueOn, amountCents: i.amountCents, paidCents: 0, disputed: false, inFlight: false, issuedOn: i.issuedOn, issuedInSim: true });
    }
    for (let n = 0; n < eventsPerDay; n++) {
      snap = { simDate: date, clients: ds.clients.map((c) => ({ ...view(c.id), eventsToday: counts.get(c.id) ?? 0 })) };
      const event = chooseEvent(snap, rng, { clientDayCap: opts.clientDayCap ?? 2 });
      if (!event) continue;
      kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      counts.set(event.clientId, (counts.get(event.clientId) ?? 0) + 1);
      maxPerClientDay = Math.max(maxPerClientDay, counts.get(event.clientId)!);
      const after = applyEvent(snap, event, day * 100 + n);
      const known = new Map((wires.get(event.clientId) ?? []).map((w) => [w.ref, w.day]));
      wires.set(event.clientId, after.clients.find((c) => c.profile.clientId === event.clientId)!.recentWires.map((w) => ({ ...w, day: known.get(w.ref) ?? day })));
      if (event.kind === 'pay') {
        const left = new Map(after.clients.find((c) => c.profile.clientId === event.clientId)!.invoices.map((i) => [i.id, i]));
        for (const id of event.invoiceIds) {
          const inv = open.get(id)!;
          const now = left.get(id);
          if (now) {
            inv.paidCents = now.paidCents;
          } else {
            paid.push({ invoiceId: id, clientId: inv.clientId, dueOn: inv.dueOn, paidOn: date, amountCents: inv.amountCents, issuedInSim: inv.issuedInSim });
            open.delete(id);
          }
        }
      }
    }
  }
  return { paid, open: [...open.values()], kinds, date, profiles, maxPerClientDay };
}
