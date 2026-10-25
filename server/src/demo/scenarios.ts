import type { DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';

/**
 * Demo scenarios: each one makes a single real-world event happen to a client that fits it right
 * now (a wire through Nessie, an RM's note, a withdrawal request). Nothing after the event is
 * scripted: payment checking, the rules, the agents and the gateway respond as they always do.
 */

export const SCENARIOS = {
  pay: 'A restricted client pays what it owes',
  parent: 'A payment arrives from a parent company, and the RM says the client already paid',
  holdOff: 'An RM asks the desk to hold off on a client',
  acquisition: 'An RM reports that a client is being acquired',
  shortWire: 'An international wire arrives $25 short',
  duplicate: 'A client sends the same wire twice',
  cureWithdrawal: 'A client in its cure period withdraws cash',
} as const;
export type ScenarioKind = keyof typeof SCENARIOS;

export interface WireInput {
  payer: { clientId?: string; name?: string };
  amount: number;
  remittance: string;
  network: 'FEDWIRE' | 'SWIFT';
  charges: number;
  status: 'posted' | 'pending';
}

interface Deps {
  conn: DbConnection;
  ds: Dataset;
  simDate: () => string;
  receiveWire: (p: WireInput) => Promise<unknown>;
  withdraw: (clientId: string, amount: number) => Promise<unknown>;
}

export interface ScenarioResult { kind: ScenarioKind; client: string; happened: string; watch: string }

const ACQUIRERS = ['Northwind Holdings', 'Halvard Partners', 'Brightwater Group', 'Meridian Capital Group'];
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = (cents: number) => Math.round(cents) / 100;

export function scenarioRunner({ conn, ds, simDate, receiveWire, withdraw }: Deps) {
  const db = conn.db;

  /** Clients with something past due, the most owed first. */
  const overdue = () => {
    const today = simDate();
    const by = new Map<string, { cents: number; ids: string[] }>();
    for (const i of db.invoice.iter()) {
      if (i.dueOn >= today || i.status === 'disputed' || i.status === 'void' || i.paidCents >= i.amountCents) continue;
      const cur = by.get(i.clientId) ?? { cents: 0, ids: [] };
      by.set(i.clientId, { cents: cur.cents + Number(i.amountCents - i.paidCents), ids: [...cur.ids, i.id] });
    }
    return [...by].map(([clientId, v]) => ({ clientId, ...v })).sort((a, b) => b.cents - a.cents);
  };
  const restricted = (id: string) => [...db.accessLever.clientId.filter(id)].some((l) => (l.state === 'limited' || l.state === 'off') && l.detail !== 'Prepay required');
  const name = (id: string) => db.client.id.find(id)?.name ?? id;
  const legal = (id: string) => ds.clients.find((c) => c.id === id)?.legalName ?? name(id);
  const strategic = (id: string) => !!db.client.id.find(id)?.strategic;
  const openCase = (id: string) => [...db.workItem.iter()].some((w) => w.clientId === id && w.kind === 'NOVEL_CASE' && (w.state === 'PROPOSED' || w.state === 'NEEDS_INFO'));
  const note = (clientId: string, text: string) => conn.reducers.addRmNote({ clientId, author: '', text, workItemId: undefined });
  const none = (what: string) => { throw new Error(`No client fits right now: ${what}. Try another scenario, or wait a business day.`); };

  async function run(kind: ScenarioKind): Promise<ScenarioResult> {
    switch (kind) {
      case 'pay': {
        const c = overdue().find((o) => restricted(o.clientId)) ?? none('nobody is restricted and overdue');
        await receiveWire({ payer: { clientId: c.clientId }, amount: dollars(c.cents), remittance: `PAYMENT ${c.ids.join(' ')}`.slice(0, 140), network: 'FEDWIRE', charges: 0, status: 'posted' });
        return { kind, client: name(c.clientId), happened: `${name(c.clientId)} wired ${usd(c.cents)} for ${c.ids.length} overdue invoice${c.ids.length > 1 ? 's' : ''}.`, watch: 'Payment checking matches it, the hold comes off, and Sage restores access.' };
      }
      case 'parent': {
        const c = overdue().find((o) => restricted(o.clientId) && !strategic(o.clientId)) ?? overdue()[0] ?? none('nobody is overdue');
        const parent = `${legal(c.clientId).replace(/\b(Inc|LLC|LP|Ltd)\.?$/i, '').trim()} Holdings Group`;
        await receiveWire({ payer: { name: parent.toUpperCase() }, amount: dollars(c.cents), remittance: '', network: 'FEDWIRE', charges: 0, status: 'posted' });
        await note(c.clientId, `${name(c.clientId)}'s CFO says they paid the full ${usd(c.cents)} yesterday from their parent company, ${parent}. Can we check and lift the restriction?`);
        return { kind, client: name(c.clientId), happened: `${usd(c.cents)} arrived from ${parent} with no invoice reference, and the RM says ${name(c.clientId)} already paid.`, watch: 'Iris and Sage trace the wire to the client from the evidence, match it, and access comes back.' };
      }
      case 'holdOff': {
        const c = overdue().find((o) => !openCase(o.clientId)) ?? none('every overdue client already has an open request');
        const until = new Date(`${simDate()}T12:00:00Z`); until.setUTCDate(until.getUTCDate() + 10);
        const by = until.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
        await note(c.clientId, `Spoke with ${name(c.clientId)}'s finance lead. A large customer payment they are waiting on lands by ${by}, and they will clear the full ${usd(c.cents)} then. They ask us not to tighten their access before that.`);
        return { kind, client: name(c.clientId), happened: `The RM asked the desk to hold off on ${name(c.clientId)} until ${by}.`, watch: 'Sage reads the note and sends it to the controller, because an exception is never the agent\'s call.' };
      }
      case 'acquisition': {
        const c = overdue().find((o) => !openCase(o.clientId) && !strategic(o.clientId)) ?? none('every overdue client already has an open request');
        const buyer = pick(ACQUIRERS);
        const close = new Date(`${simDate()}T12:00:00Z`); close.setUTCDate(close.getUTCDate() + 30);
        const by = close.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
        await note(c.clientId, `${name(c.clientId)} is being acquired by ${buyer}. The deal is expected to close on ${by}, and their CFO says the overdue invoices will be settled at closing by the buyer.`);
        return { kind, client: name(c.clientId), happened: `The RM reported that ${name(c.clientId)} is being acquired by ${buyer}.`, watch: 'Sage investigates step by step (policies, contract, exposure, custody, past decisions) and hands the case to the controller.' };
      }
      case 'shortWire': {
        const today = simDate();
        const open = [...db.invoice.iter()]
          .filter((i) => i.status === 'open' && i.paidCents === 0n && i.dueOn >= today && !restricted(i.clientId))
          .sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
        const inv = open[0] ?? none('no open invoice is coming due');
        const owed = Number(inv.amountCents);
        await receiveWire({ payer: { clientId: inv.clientId }, amount: dollars(owed), remittance: `INV ${inv.id}`, network: 'SWIFT', charges: 25, status: 'posted' });
        return { kind, client: name(inv.clientId), happened: `${name(inv.clientId)} paid ${inv.id} (${usd(owed)}) by SWIFT, and an intermediary bank kept $25.`, watch: 'Payment checking applies it in full and books the $25 to bank fees under policy, with no one asked.' };
      }
      case 'duplicate': {
        // A movement's client is the one whose invoices it paid.
        const payerOf = (movementId: string) => {
          const app = [...db.paymentApplication.movementId.filter(movementId)].find((x) => !x.reversed);
          return app ? db.invoice.id.find(app.invoiceId)?.clientId : undefined;
        };
        const last = [...db.cashMovement.iter()]
          .filter((m) => m.direction === 'in' && !m.isHistory && m.matchStatus === 'matched' && m.network === 'FEDWIRE' && m.refs.length > 0 && payerOf(m.id))
          .sort((a, b) => (a.valueOn < b.valueOn ? 1 : -1))[0] ?? none('no recent matched wire to repeat');
        const clientId = payerOf(last.id)!;
        await receiveWire({ payer: { clientId }, amount: dollars(Number(last.amountCents)), remittance: last.remittance || `PAYMENT ${last.refs.join(' ')}`, network: 'FEDWIRE', charges: 0, status: 'posted' });
        return { kind, client: name(clientId), happened: `${name(clientId)} sent ${usd(Number(last.amountCents))} again for invoices it had already paid.`, watch: 'Payment checking spots the duplicate and refunds it through Nessie on its own.' };
      }
      case 'cureWithdrawal': {
        const today = simDate();
        const inCure = [...db.deadline.iter()].filter((d) => d.kind === 'cure_period' && d.status === 'open' && d.dueOn >= today).map((d) => d.clientId);
        const clientId = inCure.find((id) => Number(db.custodyHolding.id.find(`${id}:USD`)?.valueCents ?? 0n) > 0) ?? none('no client is in a cure period with cash in custody');
        const cash = Number(db.custodyHolding.id.find(`${clientId}:USD`)!.valueCents);
        const ask = Math.max(100_000, Math.round(cash * 0.6 / 100_000) * 100_000);
        await withdraw(clientId, dollars(ask));
        return { kind, client: name(clientId), happened: `${name(clientId)} asked to withdraw ${usd(ask)} while it is in default and inside its cure period.`, watch: 'The database releases only what is not owed, and Rowan raises an alert if the withdrawal leaves too little to cover the default.' };
      }
    }
  }

  return { run };
}
