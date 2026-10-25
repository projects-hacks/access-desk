import type { Dataset } from '../dataset';
import { parseBankText } from '../integrations/bank-text/parse';
import type { Bank } from '../integrations/nessie/bank';
import { postAchCollection, postAchReturn, postIncomingWire, type IncomingWire } from '../integrations/nessie/payments-in';
import { env } from '../lib/env';
import type { DbConnection } from '../module_bindings';
import type { PlatformSimulator } from '../platform/simulator';
import type { Sync } from '../sync';
import { invoiceKey, invoicesToIssue } from './billing';
import { CallBudget } from './budget';
import { clockDecision } from './clock';
import { chooseEvent, describeEvent, formatUsd, type PlannedEvent, type WorldSnapshot } from './events';
import { PERSONALITIES, deriveProfiles, type Personality } from './personality';
import { isWorldRef, nextRef } from './refs';
import { remittanceText } from './remittance';
import { WORLD_TABLES, readClock, readSnapshot, worldRefs, type ClockView } from './snapshot';

export interface WorldConfig {
  secondsPerDay: number;
  eventMinMs: number;
  eventMaxMs: number;
  clientDayCap: number;
  bankWritesPerMinute: number;
  pauseGraceMs: number;
}

export const worldConfig = (): WorldConfig => ({
  secondsPerDay: env.WORLD_SECONDS_PER_DAY,
  eventMinMs: Math.min(env.WORLD_EVENT_MIN_SECONDS, env.WORLD_EVENT_MAX_SECONDS) * 1000,
  eventMaxMs: Math.max(env.WORLD_EVENT_MIN_SECONDS, env.WORLD_EVENT_MAX_SECONDS) * 1000,
  clientDayCap: env.WORLD_CLIENT_DAY_CAP,
  bankWritesPerMinute: env.WORLD_BANK_WRITES_PER_MINUTE,
  pauseGraceMs: env.WORLD_PAUSE_GRACE_SECONDS * 1000,
});

export interface WorldDeps {
  /** A connection under the DEMO identity: moves the clock and acts for clients (orders, withdrawals). */
  conn: DbConnection;
  sync: Sync;
  bank: Bank;
  ds: Dataset;
  platform: PlatformSimulator;
  log: (msg: string) => void;
  cfg?: WorldConfig;
}

export interface WorldEventLog {
  at: string;
  simDate: string;
  kind: PlannedEvent['kind'];
  clientId: string;
  client: string;
  personality: Personality;
  text: string;
  outcome: string;
}

const KEEP_EVENTS = 100;
const IN_FLIGHT_MS = 120_000;
const MATCH_WAIT_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The platform living on its own. One tick at a time (a slow tick delays the next, never overlaps
 * it): keep the clock at its pace, bill any month that closed, then make one client do one
 * plausible thing. Everything it decides comes from the database (and, for bank references, the
 * bank), so a restart picks up exactly where the last process left off.
 */
export class World {
  private readonly cfg: WorldConfig;
  private readonly profiles;
  private readonly db;
  private readonly budget: CallBudget;
  /** Every world bank reference seen so far (database, bank at startup, this process): the next is always above them. */
  private readonly refs = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private today = { date: '', counts: new Map<string, number>() };
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private warnedClock = '';

  readonly startedAt = new Date();
  private lastTickAt?: Date;
  private nextTickAt?: Date;
  private events: WorldEventLog[] = [];
  private totals = { events: 0, errors: 0, billed: 0 };
  private byKind: Record<string, number> = {};
  private byPersonality = Object.fromEntries(PERSONALITIES.map((p) => [p, 0])) as Record<Personality, number>;
  private billing = { lastPeriods: [] as string[], lastAt: undefined as string | undefined };
  private lastError?: { at: string; message: string };

  private constructor(private readonly deps: WorldDeps) {
    this.cfg = deps.cfg ?? worldConfig();
    this.profiles = deriveProfiles(deps.ds);
    this.db = deps.conn.db;
    this.budget = new CallBudget(this.cfg.bankWritesPerMinute);
  }

  /** Subscribes to what the world reads, and learns which bank references are already taken. */
  static async open(deps: WorldDeps): Promise<World> {
    const world = new World(deps);
    await new Promise<void>((resolve) => deps.conn.subscriptionBuilder().onApplied(() => resolve()).subscribe(WORLD_TABLES));
    await world.learnRefs().catch((e) => deps.log(`[world] could not list the bank to learn used references (the database's will do): ${errText(e)}`));
    return world;
  }

  /** A wire created at the bank but not yet synced when the last process died must not be reused. */
  private async learnRefs() {
    for (const ref of worldRefs(this.db)) this.refs.add(ref);
    const collections = this.deps.bank.map.accounts.collections;
    if (!collections) return;
    for (const list of [await this.deps.bank.api.listDeposits(collections.id), await this.deps.bank.api.listWithdrawals(collections.id)]) {
      for (const tx of list) {
        const ref = parseBankText(tx.description).bankRef;
        if (ref && isWorldRef(ref)) this.refs.add(ref);
      }
    }
  }

  start(): () => void {
    this.stopped = false;
    const { eventMinMs: lo, eventMaxMs: hi } = this.cfg;
    const schedule = (ms: number) => {
      if (this.stopped) return;
      this.nextTickAt = new Date(Date.now() + ms);
      this.timer = setTimeout(() => void this.tick().finally(() => schedule(lo + Math.random() * (hi - lo))), ms);
    };
    this.deps.log(`[world] living: one sim day every ${this.cfg.secondsPerDay}s, a client event every ${lo / 1000}-${hi / 1000}s, ${this.profiles.size} clients`);
    schedule(5_000);
    return () => {
      this.stopped = true;
      clearTimeout(this.timer);
    };
  }

  /** One step. Never overlaps itself, never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.lastTickAt = new Date();
    try {
      const clock = await this.keepClock();
      if (!clock) return;
      await this.bill(clock);
      await this.act();
    } catch (e) {
      this.totals.errors++;
      this.lastError = { at: new Date().toISOString(), message: errText(e) };
      this.deps.log(`[world] tick failed: ${errText(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async keepClock(): Promise<ClockView | undefined> {
    const clock = readClock(this.db);
    if (!clock) return undefined;
    const decision = clockDecision(clock, { secondsPerDay: this.cfg.secondsPerDay, graceMs: this.cfg.pauseGraceMs }, Date.now());
    if (decision === 'resume') {
      await this.deps.conn.reducers.setClockSpeed({ secondsPerDay: this.cfg.secondsPerDay, runUntil: undefined });
      this.deps.log(`[world] clock was paused: running again, one sim day every ${this.cfg.secondsPerDay}s`);
    } else if (decision === 'foreign') {
      const seen = `${clock.secondsPerDay}/${clock.runUntil ?? ''}`;
      if (this.warnedClock !== seen) this.deps.log(`[world] clock runs at 1 day per ${clock.secondsPerDay}s${clock.runUntil ? ` until ${clock.runUntil}` : ''}, set by someone else: leaving it`);
      this.warnedClock = seen;
    }
    return clock;
  }

  private snapshot(): { snapshot: WorldSnapshot; clock: ClockView } | undefined {
    const now = Date.now();
    for (const [id, until] of this.inFlight) if (until < now) this.inFlight.delete(id);
    try {
      const today = this.db.clock.id.find(1)?.simDate;
      if (today && this.today.date !== today) this.today = { date: today, counts: new Map() };
      return readSnapshot(this.db, this.deps.ds, this.profiles, { inFlight: new Set(this.inFlight.keys()), eventsToday: this.today.counts });
    } catch (e) {
      this.deps.log(`[world] cannot read the database yet: ${errText(e)}`);
      return undefined;
    }
  }

  /** The month closed: billing issues its invoices, books them, and sync carries them to the database. */
  private async bill(clock: ClockView) {
    const { ds, platform, sync } = this.deps;
    const existing = [...platform.invoices.values(), ...this.db.invoice.iter()];
    const issued = invoicesToIssue(ds, clock.simDate, {
      ids: existing.map((i) => i.id),
      keys: new Set(existing.map((i) => invoiceKey(i.clientId, i.product, i.period))),
    });
    if (!issued.length) return;
    platform.issue(issued);
    const periods = [...new Set(issued.map((i) => i.period))];
    this.totals.billed += issued.length;
    this.billing = { lastPeriods: periods, lastAt: new Date().toISOString() };
    const total = issued.reduce((s, i) => s + i.amountCents, 0);
    this.deps.log(`[world] billing · ${clock.simDate}: issued ${issued.length} invoices for ${periods.join(', ')} (${issued[0]!.id}..${issued.at(-1)!.id}, ${formatUsd(total)})`);
    await sync.bookInvoices(issued.map((i) => i.id)).catch((e) => this.deps.log(`[world] booking the billing run failed (the sync below retries): ${errText(e)}`));
    await sync.full().then(
      (results) => results.filter((r) => r.errors.length).forEach((r) => sync.report(r)),
      (e) => this.deps.log(`[world] billing sync failed (the next sync pass retries): ${errText(e)}`),
    );
  }

  private async act() {
    const read = this.snapshot();
    if (!read) return;
    for (const ref of worldRefs(this.db)) this.refs.add(ref);
    const event = chooseEvent(read.snapshot, Math.random, { clientDayCap: this.cfg.clientDayCap });
    if (!event) return;
    const bankWrites = event.kind === 'pay' || event.kind === 'duplicate' || event.kind === 'ach_return' ? 2 : 0;
    if (bankWrites && !this.budget.take(bankWrites)) {
      this.deps.log(`[world] holding ${event.kind} for ${event.clientId}: ${this.budget.used()} bank writes in the last minute (cap ${this.cfg.bankWritesPerMinute})`);
      return;
    }
    const profile = this.profiles.get(event.clientId)!;
    const text = describeEvent(event, profile.name);
    let outcome: string;
    try {
      outcome = await this.perform(event, read.snapshot);
    } catch (e) {
      this.totals.errors++;
      outcome = `failed: ${errText(e)}`;
      this.lastError = { at: new Date().toISOString(), message: `${event.kind} ${event.clientId}: ${errText(e)}` };
    }
    this.today.counts.set(event.clientId, (this.today.counts.get(event.clientId) ?? 0) + 1);
    this.totals.events++;
    this.byKind[event.kind] = (this.byKind[event.kind] ?? 0) + 1;
    this.byPersonality[profile.personality]++;
    this.events.unshift({ at: new Date().toISOString(), simDate: read.snapshot.simDate, kind: event.kind, clientId: event.clientId, client: profile.name, personality: profile.personality, text, outcome });
    this.events.length = Math.min(this.events.length, KEEP_EVENTS);
    this.deps.log(`[world] ${read.snapshot.simDate} ${event.kind} · ${text} (${profile.personality}) · ${outcome}`);
  }

  private async perform(e: PlannedEvent, snap: WorldSnapshot): Promise<string> {
    switch (e.kind) {
      case 'pay': return this.pay(e, snap);
      case 'duplicate': return this.duplicate(e, snap);
      case 'ach_return': return this.achReturn(e, snap);
      case 'withdraw': return this.withdraw(e);
      case 'trade': return this.trade(e);
    }
  }

  private async pay(e: Extract<PlannedEvent, { kind: 'pay' }>, snap: WorldSnapshot): Promise<string> {
    const { ds, bank, sync } = this.deps;
    const client = ds.clients.find((c) => c.id === e.clientId)!;
    const profile = this.profiles.get(client.id)!;
    const affiliate = e.payer === 'affiliate' ? ds.affiliates.find((a) => a.key === profile.affiliateKey) : undefined;
    const payerBank = affiliate?.bank ?? client.bank;
    const remittance = remittanceText(e, client, payerBank.country, this.deps.platform.invoices.get(e.invoiceIds[0]!)?.period ?? snap.simDate.slice(0, 7));
    const ref = nextRef(e.rail === 'ACH' ? 'ach' : 'wire', this.refs);
    this.refs.add(ref);
    for (const id of e.invoiceIds) this.inFlight.set(id, Date.now() + IN_FLIGHT_MS);

    const accountKey = affiliate ? `aff:${affiliate.key}` : client.id;
    const account = bank.map.accounts[accountKey]?.number;
    if (!account) throw new Error(`no bank account ${accountKey}`);
    if (e.rail === 'ACH') {
      await postAchCollection(bank, ds.platform.legalName, {
        trace: ref, date: snap.simDate, payer: { clientId: client.id, legalName: client.legalName, account, accountKey }, amountCents: e.amountCents, addenda: remittance,
      });
    } else {
      await postIncomingWire(bank, ds.platform.legalName, {
        trn: ref, date: snap.simDate, payer: { name: affiliate?.legalName ?? (e.reference === 'none' ? profile.memoName : undefined) ?? client.legalName, account, bank: payerBank, accountKey },
        amountCents: e.amountCents, remittance, status: 'completed',
        swift: payerBank.country !== 'US' ? { chargeBearer: affiliate ? 'OUR' : 'SHA', chargesCents: e.chargesCents } : undefined,
      });
    }
    return this.afterBankWrite(ref, [client.id, ...(affiliate ? [accountKey] : [])]);
  }

  private async duplicate(e: Extract<PlannedEvent, { kind: 'duplicate' }>, snap: WorldSnapshot): Promise<string> {
    const { ds, bank } = this.deps;
    const client = ds.clients.find((c) => c.id === e.clientId)!;
    const profile = this.profiles.get(client.id)!;
    const original = snap.clients.find((c) => c.profile.clientId === client.id)!.recentWires.find((w) => w.ref === e.ref);
    if (!original) throw new Error(`${e.ref} is no longer a recent wire`);
    const affiliate = original.payer === 'affiliate' ? ds.affiliates.find((a) => a.key === profile.affiliateKey) : undefined;
    const accountKey = affiliate ? `aff:${affiliate.key}` : client.id;
    const account = bank.map.accounts[accountKey]?.number;
    if (!account) throw new Error(`no bank account ${accountKey}`);
    const payerBank = affiliate?.bank ?? client.bank;
    const ref = nextRef('wire', this.refs);
    this.refs.add(ref);
    const wire: IncomingWire = {
      trn: ref, date: snap.simDate, payer: { name: affiliate?.legalName ?? client.legalName, account, bank: payerBank, accountKey },
      amountCents: original.amountCents, remittance: original.remittance, status: 'completed',
      swift: payerBank.country !== 'US' ? { chargeBearer: affiliate ? 'OUR' : 'SHA', chargesCents: original.chargesCents } : undefined,
    };
    await postIncomingWire(bank, ds.platform.legalName, wire);
    return this.afterBankWrite(ref, [client.id, ...(affiliate ? [accountKey] : [])]);
  }

  private async achReturn(e: Extract<PlannedEvent, { kind: 'ach_return' }>, snap: WorldSnapshot): Promise<string> {
    const { ds, bank } = this.deps;
    const client = ds.clients.find((c) => c.id === e.clientId)!;
    const original = [...this.db.cashMovement.bankRef.filter(e.ref)].find((m) => !m.isHistory);
    const account = bank.map.accounts[client.id]?.number;
    if (!original || !account) throw new Error(`${e.ref} not found`);
    const ref = nextRef('ach', this.refs);
    this.refs.add(ref);
    await postAchReturn(bank, ds.platform.legalName, {
      trace: ref, originalTrace: e.ref, date: snap.simDate, payer: { clientId: client.id, legalName: client.legalName, account, accountKey: client.id }, amountCents: Number(original.amountCents),
    });
    return this.afterBankWrite(ref, [client.id]);
  }

  /** The bank has it: pull it into the database now and report what payment checking made of it. */
  private async afterBankWrite(ref: string, accounts: string[]): Promise<string> {
    await this.deps.sync.cash(accounts);
    const deadline = Date.now() + MATCH_WAIT_MS;
    for (;;) {
      const m = [...this.db.cashMovement.bankRef.filter(ref)].find((x) => !x.isHistory);
      if (m && m.matchStatus !== 'unmatched') return `${ref} ${m.matchStatus}${m.parseNotes ? ` (${m.parseNotes.split(';')[0]})` : ''}`;
      if (Date.now() > deadline) return m ? `${ref} landed, matching in progress` : `${ref} sent, not yet in the database`;
      await sleep(150);
    }
  }

  private async withdraw(e: Extract<PlannedEvent, { kind: 'withdraw' }>): Promise<string> {
    const before = new Set([...this.db.accessRequest.clientId.filter(e.clientId)].map((r) => r.id));
    try {
      await this.deps.conn.reducers.requestCustodyWithdrawal({ clientId: e.clientId, amountCents: BigInt(e.amountCents) });
    } catch (err) {
      return `refused: ${errText(err)}`;
    }
    const request = await this.waitFor(() => [...this.db.accessRequest.clientId.filter(e.clientId)].find((r) => !before.has(r.id)));
    return request
      ? `${request.decision}: ${formatUsd(Number(request.allowedCents))} released${request.heldCents > 0n ? `, ${formatUsd(Number(request.heldCents))} held` : ''}`
      : 'requested';
  }

  private async trade(e: Extract<PlannedEvent, { kind: 'trade' }>): Promise<string> {
    const before = new Set([...this.db.tradeOrder.clientId.filter(e.clientId)].map((o) => o.id));
    try {
      await this.deps.conn.reducers.placeOrder({ clientId: e.clientId, side: e.side, asset: e.asset, amountCents: BigInt(e.amountCents) });
    } catch (err) {
      return `refused: ${errText(err)}`;
    }
    const order = await this.waitFor(() => [...this.db.tradeOrder.clientId.filter(e.clientId)].find((o) => !before.has(o.id)));
    if (!order) return 'placed';
    return order.status === 'refused' ? `refused: ${order.reason}` : `${order.status} at ${formatUsd(Number(order.priceCents))}`;
  }

  private async waitFor<T>(find: () => T | undefined, ms = 2_000): Promise<T | undefined> {
    const deadline = Date.now() + ms;
    for (let found = find(); ; found = find()) {
      if (found !== undefined || Date.now() > deadline) return found;
      await sleep(100);
    }
  }

  /** What /world/state shows. */
  state() {
    const clock = readClock(this.db);
    const byClients = Object.fromEntries(PERSONALITIES.map((p) => [p, [] as string[]])) as Record<Personality, string[]>;
    for (const p of this.profiles.values()) byClients[p.personality].push(p.name);
    return {
      enabled: true,
      startedAt: this.startedAt.toISOString(),
      lastTickAt: this.lastTickAt?.toISOString(),
      nextTickInSeconds: this.nextTickAt ? Math.max(0, Math.round((this.nextTickAt.getTime() - Date.now()) / 1000)) : undefined,
      pace: {
        secondsPerDay: this.cfg.secondsPerDay,
        clientEveryS: [this.cfg.eventMinMs / 1000, this.cfg.eventMaxMs / 1000],
        clientDayCap: this.cfg.clientDayCap,
        bankWritesPerMinute: { used: this.budget.used(), cap: this.cfg.bankWritesPerMinute },
      },
      clock: clock && {
        simDate: clock.simDate,
        running: clock.secondsPerDay > 0,
        secondsPerDay: clock.secondsPerDay,
        runUntil: clock.runUntil ?? null,
        owner: clockDecision(clock, { secondsPerDay: this.cfg.secondsPerDay, graceMs: this.cfg.pauseGraceMs }, Date.now()),
      },
      totals: this.totals,
      byKind: this.byKind,
      personalities: Object.fromEntries(PERSONALITIES.map((p) => [p, { clients: byClients[p].length, events: this.byPersonality[p], names: byClients[p] }])),
      billing: this.billing,
      lastError: this.lastError ?? null,
      last: this.events.slice(0, 20),
    };
  }
}
