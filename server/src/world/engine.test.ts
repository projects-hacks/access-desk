import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { holdingsFor, leversFor } from '../dataset/platform-data';
import type { Bank } from '../integrations/nessie/bank';
import { FakeNessie } from '../integrations/nessie/fake';
import { buildSeedPlan } from '../integrations/nessie/seed-plan';
import type { DbConnection } from '../module_bindings';
import type { CashMovement } from '../module_bindings/types';
import { PlatformSimulator } from '../platform/simulator';
import type { Sync } from '../sync';
import { toCashMovement } from '../sync/sources/bank';
import { World, type WorldConfig, type WorldDeps } from './engine';
import { isWorldRef } from './refs';

/**
 * The engine end to end against stand-ins: the dataset's open book in a fake database, the fake
 * bank, and a sync that reads the bank into the database the way the real one does (the same
 * bank-text parser). Payment checking is the module's job and is not run here; world wires are
 * simply marked matched. What this proves is the wiring: the clock, billing, event execution,
 * unique references, restarts, and the state endpoint.
 */
const ds = loadDataset();
const plan = buildSeedPlan(ds);

function table<T extends object>(rows: T[], index: Record<string, keyof T> = {}) {
  const by = (key: keyof T) => ({
    find: (v: unknown) => rows.find((r) => r[key] === v) ?? null,
    filter: (v: unknown) => rows.filter((r) => r[key] === v),
  });
  return { iter: () => rows[Symbol.iterator](), ...Object.fromEntries(Object.entries(index).map(([name, key]) => [name, by(key)])) };
}

async function fixture(simDate = '2026-04-02') {
  const { bank: api, map } = await FakeNessie.seeded(plan);
  const bank: Bank = { api, map, mode: 'fake' };
  const platform = new PlatformSimulator(ds);
  const stamp = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n });
  const state = {
    clock: [{ id: 1, simDate, secondsPerDay: 0, runUntil: undefined as string | undefined, updatedAt: stamp(0) }],
    invoice: ds.invoices.map((i) => ({ id: i.id, clientId: i.clientId, product: i.product, period: i.period, issuedOn: i.issuedOn, dueOn: i.dueOn, amountCents: BigInt(i.amountCents), paidCents: BigInt(i.paidCents), status: i.status, label: i.label, sourcePaidCents: 0n })),
    cashMovement: [] as CashMovement[],
    accessLever: ds.clients.flatMap(leversFor),
    custodyHolding: ds.clients.flatMap(holdingsFor).map((h) => ({ ...h, valueCents: BigInt(h.valueCents) })),
    hold: [] as { clientId: string; status: string; amountCents: bigint }[],
    deadline: [] as { id: bigint; kind: string; clientId: string; status: string; dueOn: string }[],
    payerIdentity: [
      ...ds.clients.map((c) => ({ id: `${c.id}:acct`, clientId: c.id, kind: 'bank_account', value: map.accounts[c.id]!.number })),
      ...ds.affiliates.map((a) => ({ id: `aff:${a.key}:acct`, clientId: a.parentId, kind: 'bank_account', value: map.accounts[`aff:${a.key}`]!.number })),
    ],
    tradeOrder: [] as { id: bigint; clientId: string; status: string; reason: string; priceCents: bigint; at: ReturnType<typeof stamp> }[],
    accessRequest: [] as { id: bigint; clientId: string; action: string; decision: string; allowedCents: bigint; heldCents: bigint; at: ReturnType<typeof stamp> }[],
  };
  const calls: string[] = [];
  const conn = {
    db: {
      clock: table(state.clock, { id: 'id' }),
      invoice: table(state.invoice, { id: 'id' }),
      cashMovement: table(state.cashMovement, { bankRef: 'bankRef' }),
      accessLever: table(state.accessLever, { id: 'id' }),
      custodyHolding: table(state.custodyHolding, { id: 'id' }),
      hold: table(state.hold),
      deadline: table(state.deadline),
      payerIdentity: table(state.payerIdentity),
      tradeOrder: table(state.tradeOrder, { clientId: 'clientId' }),
      accessRequest: table(state.accessRequest, { clientId: 'clientId' }),
    },
    subscriptionBuilder: () => ({ onApplied: (cb: () => void) => ({ subscribe: () => cb() }) }),
    reducers: {
      setClockSpeed: async ({ secondsPerDay }: { secondsPerDay: number }) => {
        calls.push(`clock ${secondsPerDay}`);
        Object.assign(state.clock[0]!, { secondsPerDay, updatedAt: stamp(Date.now()) });
      },
      placeOrder: async ({ clientId, side, asset, amountCents }: { clientId: string; side: string; asset: string; amountCents: bigint }) => {
        calls.push(`order ${clientId} ${side} ${asset} ${amountCents}`);
        state.tradeOrder.push({ id: BigInt(state.tradeOrder.length + 1), clientId, status: 'queued', reason: '', priceCents: 8_500_000n, at: stamp(Date.now()) });
      },
      requestCustodyWithdrawal: async ({ clientId, amountCents }: { clientId: string; amountCents: bigint }) => {
        calls.push(`withdraw ${clientId} ${amountCents}`);
        state.accessRequest.push({ id: BigInt(state.accessRequest.length + 1), clientId, action: 'withdraw', decision: 'approved', allowedCents: amountCents, heldCents: 0n, at: stamp(Date.now()) });
      },
    },
  } as unknown as DbConnection;

  const imported = new Set<string>();
  const sync = {
    cash: async () => {
      const collections = map.accounts.collections!;
      for (const [kind, txs] of [['deposit', await api.listDeposits(collections.id)], ['withdrawal', await api.listWithdrawals(collections.id)]] as const) {
        for (const tx of txs) {
          if (imported.has(tx._id)) continue;
          const row = await toCashMovement(tx, kind, 'collections');
          if (!isWorldRef(row.bankRef)) continue;
          imported.add(tx._id);
          state.cashMovement.push({ ...row, matchStatus: 'matched' });
        }
      }
      return [];
    },
    full: async () => {
      for (const i of platform.invoices.values()) {
        if (!state.invoice.some((x) => x.id === i.id)) {
          state.invoice.push({ id: i.id, clientId: i.clientId, product: i.product, period: i.period, issuedOn: i.issuedOn, dueOn: i.dueOn, amountCents: BigInt(i.amountCents), paidCents: 0n, status: 'open', label: i.label, sourcePaidCents: 0n });
        }
      }
      return [];
    },
    report: () => undefined,
  } as unknown as Sync;

  const logs: string[] = [];
  const cfg: WorldConfig = { secondsPerDay: 240, eventMinMs: 20_000, eventMaxMs: 60_000, clientDayCap: 2, bankWritesPerMinute: 1000, pauseGraceMs: 0 };
  const deps: WorldDeps = { conn, sync, bank, ds, platform, log: (m) => logs.push(m), cfg };
  const open = (over: Partial<WorldDeps> = {}) => World.open({ ...deps, ...over });
  return { state, calls, logs, open, platform, api, map };
}

test('a paused clock is resumed, the closed month is billed, and clients act through the real paths', async () => {
  const f = await fixture();
  const world = await f.open();
  await world.tick();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('clock')), ['clock 240']);
  assert.equal(world.state().billing.lastPeriods[0], '2026-03');
  const issued = [...f.platform.invoices.values()].filter((i) => i.period === '2026-03');
  assert.equal(issued.length, ds.clients.reduce((n, c) => n + c.products.length, 0));
  assert.ok(issued.every((i) => f.platform.journals.has(`JE-INV-${i.id}`)));
  assert.equal(f.state.invoice.filter((i) => i.period === '2026-03').length, issued.length); // sync carried them

  for (let i = 0; i < 40; i++) await world.tick();
  const s = world.state();
  assert.ok(s.totals.events >= 38 && s.totals.errors === 0, JSON.stringify(s.totals));
  assert.equal(s.last.length, 20);
  assert.equal(Object.values(s.byKind).reduce((a, b) => a + b, 0), s.totals.events);
  assert.equal(Object.values(s.personalities).reduce((a, p) => a + p.clients, 0), ds.clients.length);
  assert.equal(s.pace.secondsPerDay, 240);
  assert.equal(f.logs.filter((l) => l.includes(' pay · ')).length, s.byKind.pay);

  // Money left a client's bank account and landed in collections, parseable, each with its own reference.
  const refs = f.state.cashMovement.map((m) => m.bankRef);
  assert.ok(refs.length >= s.byKind.pay!);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(f.state.cashMovement.every((m) => m.category !== 'unknown' && m.parseConfidence >= 0.9 && m.refs.length >= 0));
  assert.ok(f.state.cashMovement.some((m) => m.refs.some((r) => r.startsWith('INV-'))));
  const collections = f.map.accounts.collections!.id;
  assert.ok((await f.api.listDeposits(collections)).length > ds.movements.filter((m) => m.direction === 'in').length);
});

test('a person who set another clock speed is left alone', async () => {
  const f = await fixture();
  Object.assign(f.state.clock[0]!, { secondsPerDay: 30 });
  const world = await f.open();
  await world.tick();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('clock')), []);
  assert.ok(f.logs.some((l) => l.includes('set by someone else')));
});

test('a restart bills nothing twice and never reuses a bank reference', async () => {
  const f = await fixture();
  const first = await f.open();
  for (let i = 0; i < 25; i++) await first.tick();
  const before = f.state.cashMovement.map((m) => m.bankRef);
  const issuedBefore = f.platform.invoices.size;

  // A new process: platform rebuilt from the database's invoices (as openPlatform does), a new engine.
  const restarted = new PlatformSimulator(ds);
  restarted.issue([...f.state.invoice].filter((i) => !restarted.invoices.has(i.id)).map((i) => ({
    id: i.id, clientId: i.clientId, product: i.product as 'API', label: i.label, period: i.period, issuedOn: i.issuedOn, dueOn: i.dueOn, amountCents: Number(i.amountCents), paidCents: 0, status: 'open' as const,
  })));
  assert.equal(restarted.invoices.size, issuedBefore);
  const again = await f.open({ platform: restarted });
  for (let i = 0; i < 25; i++) await again.tick();
  assert.equal(restarted.invoices.size, issuedBefore);
  const all = f.state.cashMovement.map((m) => m.bankRef);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length > before.length);
});

test('two ticks that overlap do not both act', async () => {
  const f = await fixture();
  const world = await f.open();
  await Promise.all([world.tick(), world.tick(), world.tick()]);
  assert.equal(world.state().totals.events, 1);
});
