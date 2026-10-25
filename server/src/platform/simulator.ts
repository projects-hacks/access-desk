import type { Dataset, Invoice } from '../dataset';
import { baselineJournals, isBalanced, type Journal } from '../dataset/gl';
import { PRICES, holdingsFor, leversFor, type HoldingRow, type LeverRow } from '../dataset/platform-data';
import type { GatewayAction, GatewayResult, InvoiceState } from './commands';

export class PlatformError extends Error {}

/**
 * The platform's systems of record: billing, general ledger, admin console,
 * custody. State = dataset baseline + every gateway command applied, in order.
 * Commands are idempotent by id, so replaying them after a restart is safe.
 */
export class PlatformSimulator {
  readonly invoices = new Map<string, Invoice>();
  readonly levers = new Map<string, LeverRow>();
  readonly holds = new Map<string, { clientId: string; amountCents: number; clause: string; status: 'active' | 'released' }>();
  readonly holdings = new Map<string, HoldingRow>();
  readonly journals = new Map<string, Journal>();
  readonly notices: { messageId: string; clientId: string; channel: string; body: string }[] = [];
  /** Cents per unit: the dataset's, until the live feed (integrations/prices.ts) moves them. */
  readonly prices = new Map<string, { cents: number; asOf?: string }>(Object.entries(PRICES).map(([a, cents]) => [a, { cents }]));
  private readonly results = new Map<string, GatewayResult>();

  constructor(private readonly ds: Dataset) {
    this.reset();
  }

  /** Back to the dataset baseline (used by the demo reset). */
  reset() {
    for (const store of [this.invoices, this.levers, this.holds, this.holdings, this.journals, this.results]) store.clear();
    this.notices.length = 0;
    for (const i of this.ds.invoices) this.invoices.set(i.id, { ...i });
    for (const c of this.ds.clients) {
      for (const l of leversFor(c)) this.levers.set(l.id, { ...l });
      for (const h of holdingsFor(c)) this.holdings.set(h.id, { ...h });
    }
    for (const j of baselineJournals(this.ds)) this.journals.set(j.journalId, j);
    for (const asset of this.prices.keys()) this.revalue(asset);
  }

  /** A new market price: revalues every holding of that asset. Returns the holdings that changed. */
  setPrice(asset: string, cents: number, asOf: string): HoldingRow[] {
    this.prices.set(asset, { cents, asOf });
    return this.revalue(asset);
  }

  private revalue(asset: string): HoldingRow[] {
    const cents = this.prices.get(asset)?.cents;
    if (cents === undefined) return [];
    const changed: HoldingRow[] = [];
    for (const h of this.holdings.values()) {
      if (h.asset !== asset) continue;
      const value = Math.round(h.quantity * cents);
      if (value === h.valueCents) continue;
      h.valueCents = value;
      changed.push(h);
    }
    return changed;
  }

  /** Apply a command once. Repeating a command id returns the original result without changing anything. */
  apply(commandId: string, action: GatewayAction): GatewayResult {
    const done = this.results.get(commandId);
    if (done) return done;
    const result = this.execute(action);
    this.results.set(commandId, result);
    return result;
  }

  private execute(a: GatewayAction): GatewayResult {
    switch (a.type) {
      case 'APPLY_PAYMENT':
      case 'REVERSE_PAYMENT': {
        const sign = a.type === 'APPLY_PAYMENT' ? 1 : -1;
        const touched = new Set<string>();
        for (const line of a.applications) {
          const inv = this.invoice(line.invoiceId);
          const paid = inv.paidCents + sign * line.amountCents;
          if (paid < 0 || paid > inv.amountCents) throw new PlatformError(`${inv.id}: paid would be ${paid} of ${inv.amountCents}`);
          inv.paidCents = paid;
          inv.status = paid >= inv.amountCents ? 'paid' : 'open';
          inv.paidOn = paid >= inv.amountCents ? (inv.paidOn ?? a.on) : undefined;
          touched.add(inv.id);
        }
        return { type: a.type, invoices: [...touched].map((id) => this.invoiceState(id)) };
      }
      case 'POST_JOURNAL': {
        const journal: Journal = { ...a.journal, source: 'access-desk' };
        if (!isBalanced(journal)) throw new PlatformError(`${journal.journalId} does not balance`);
        const existing = this.journals.get(journal.journalId);
        if (existing && existing.source !== 'access-desk') throw new PlatformError(`${journal.journalId} already booked by ${existing.source}`);
        this.journals.set(journal.journalId, journal);
        return { type: 'POST_JOURNAL', journalId: journal.journalId };
      }
      case 'PLACE_HOLD': {
        this.client(a.clientId);
        this.holds.set(a.holdId, { clientId: a.clientId, amountCents: a.amountCents, clause: a.clause, status: 'active' });
        return { type: a.type, lever: this.setLever(a.clientId, 'withdrawals', 'limited', `$${(a.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} held (§${a.clause})`) };
      }
      case 'RELEASE_HOLD': {
        const hold = this.holds.get(a.holdId);
        if (hold) hold.status = 'released';
        const stillHeld = [...this.holds.values()].some((h) => h.clientId === a.clientId && h.status === 'active');
        return { type: a.type, lever: stillHeld ? this.leverState(`${a.clientId}:withdrawals`) : this.setLever(a.clientId, 'withdrawals', 'active', 'Hold released · all assets withdrawable') };
      }
      case 'SET_LEVER':
        return { type: a.type, lever: this.setLever(a.clientId, a.lever, a.state, a.detail) };
      case 'CUSTODY_DEBIT': {
        const usd = this.holdings.get(`${a.clientId}:USD`);
        if (!usd) throw new PlatformError(`${a.clientId} has no USD custody balance`);
        if (usd.valueCents < a.amountCents) throw new PlatformError(`${a.clientId} USD balance ${usd.valueCents} < ${a.amountCents}`);
        const owed = a.invoiceIds.map((id) => this.invoice(id)).reduce((s, i) => s + i.amountCents - i.paidCents, 0);
        if (owed !== a.amountCents) throw new PlatformError(`debit ${a.amountCents} != ${owed} owed on ${a.invoiceIds.join(' ')}`);
        usd.valueCents -= a.amountCents;
        usd.quantity = usd.valueCents / PRICES.USD;
        for (const id of a.invoiceIds) {
          const inv = this.invoice(id);
          inv.paidCents = inv.amountCents;
          inv.status = 'paid';
          inv.paidOn = a.on;
        }
        return {
          type: 'CUSTODY_DEBIT',
          invoices: a.invoiceIds.map((id) => this.invoiceState(id)),
          holdings: [{ id: usd.id, quantity: usd.quantity, valueCents: usd.valueCents }],
        };
      }
      case 'CUSTODY_WITHDRAWAL': {
        const usd = this.holdings.get(`${a.clientId}:USD`);
        if (!usd) throw new PlatformError(`${a.clientId} has no USD custody balance`);
        const held = [...this.holds.values()].filter((h) => h.clientId === a.clientId && h.status === 'active').reduce((s, h) => s + h.amountCents, 0);
        if (usd.valueCents - held < a.amountCents) throw new PlatformError(`${a.clientId} can withdraw ${usd.valueCents - held}, asked ${a.amountCents}`);
        usd.valueCents -= a.amountCents;
        usd.quantity = usd.valueCents / PRICES.USD;
        return { type: 'CUSTODY_WITHDRAWAL', holdings: [{ id: usd.id, quantity: usd.quantity, valueCents: usd.valueCents }] };
      }
      case 'SEND_NOTICE': {
        const messageId = `MSG-${String(this.notices.length + 1).padStart(5, '0')}`;
        this.notices.push({ messageId, clientId: a.clientId, channel: a.channel, body: a.body });
        return { type: 'SEND_NOTICE', messageId };
      }
      case 'TRADE': {
        const usd = this.holdings.get(`${a.clientId}:USD`);
        if (!usd) throw new PlatformError(`${a.clientId} has no USD custody balance`);
        const id = `${a.clientId}:${a.asset}`;
        const coin = this.holdings.get(id) ?? { id, clientId: a.clientId, asset: a.asset, quantity: 0, valueCents: 0 };
        if (a.side === 'buy') {
          const held = [...this.holds.values()].filter((h) => h.clientId === a.clientId && h.status === 'active').reduce((s, h) => s + h.amountCents, 0);
          if (usd.valueCents - held < a.amountCents) throw new PlatformError(`${a.clientId} has ${usd.valueCents - held} free, order is ${a.amountCents}`);
          usd.valueCents -= a.amountCents;
          coin.quantity += a.quantity;
        } else {
          if (coin.quantity + 1e-9 < a.quantity) throw new PlatformError(`${a.clientId} holds ${coin.quantity} ${a.asset}, order is ${a.quantity}`);
          coin.quantity = Math.max(0, coin.quantity - a.quantity);
          usd.valueCents += a.amountCents;
        }
        usd.quantity = usd.valueCents / PRICES.USD;
        coin.valueCents = Math.round(coin.quantity * (this.prices.get(a.asset)?.cents ?? 0));
        this.holdings.set(id, coin);
        const state = (h: HoldingRow) => ({ id: h.id, quantity: h.quantity, valueCents: h.valueCents });
        return { type: 'TRADE', holdings: [state(usd), state(coin)] };
      }
      case 'REFUND':
        // Money moves at the bank, not here; the gateway sends refunds to Nessie.
        throw new PlatformError('REFUND is executed against the bank, not the platform');
    }
  }

  private client(id: string) {
    const c = this.ds.clients.find((x) => x.id === id);
    if (!c) throw new PlatformError(`unknown client ${id}`);
    return c;
  }

  private invoice(id: string): Invoice {
    const inv = this.invoices.get(id);
    if (!inv) throw new PlatformError(`unknown invoice ${id}`);
    return inv;
  }

  private invoiceState(id: string): InvoiceState {
    const inv = this.invoice(id);
    return { id, paidCents: inv.paidCents, paidOn: inv.paidOn ?? null };
  }

  private setLever(clientId: string, lever: string, state: string, detail: string) {
    const id = `${clientId}:${lever}`;
    const row = this.levers.get(id);
    if (!row) throw new PlatformError(`unknown lever ${id}`);
    if (row.state === 'not_used') throw new PlatformError(`${id} is not part of the contract`);
    row.state = state;
    row.detail = detail;
    return this.leverState(id);
  }

  private leverState(id: string) {
    const row = this.levers.get(id);
    if (!row) throw new PlatformError(`unknown lever ${id}`);
    return { id, state: row.state, detail: row.detail };
  }
}
