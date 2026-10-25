import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { resetBank, settleWire } from '../integrations/nessie/reset';
import { postIncomingWire } from '../integrations/nessie/payments-in';
import type { SeedPlan } from '../integrations/nessie/seed-plan';
import { env } from '../lib/env';
import type { Gateway } from '../gateway/executor';
import type { PlatformSimulator } from '../platform/simulator';
import type { Sync } from '../sync';

interface Deps {
  /** Connection under the DEMO identity (may move the clock and reset the world). */
  conn: DbConnection;
  sync: Sync;
  gateway: () => Gateway | undefined;
  bank: Bank;
  plan: SeedPlan;
  ds: Dataset;
  platform: PlatformSimulator;
}

const InjectSchema = z.object({
  /** A known client (pays from its account on file) or any name (an account we've never seen). */
  payer: z.object({ clientId: z.string().optional(), name: z.string().optional() }).refine((p) => p.clientId || p.name, 'payer needs clientId or name'),
  amount: z.number().positive().describe('Dollars received'),
  remittance: z.string().max(140).default(''),
  network: z.enum(['FEDWIRE', 'SWIFT']).default('FEDWIRE'),
  /** SWIFT only: intermediary charges deducted on the way (SHA). */
  charges: z.number().min(0).default(0),
  status: z.enum(['posted', 'pending']).default('posted'),
});

const PaySchema = z.object({ clientId: z.string() });

const WithdrawSchema = z.object({ clientId: z.string(), amount: z.number().positive().describe('Dollars requested') });

const PortalAsSchema = z.object({ clientId: z.string().min(1), identity: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'identity must be a 64-char hex identity') });

const toCents = (dollars: number) => Math.round(dollars * 100);

/**
 * Demo controls, enabled with DEMO_CONTROLS=true. Every action goes through the
 * real path: Nessie writes, sync, payment checking, gateway, tie-out.
 */
export async function demoRoutes(app: FastifyInstance, deps: Deps) {
  const { conn, sync, bank, plan, ds, platform } = deps;
  // Demo actions move money and can reset the shared world: callers send the team's key.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'POST' && env.DEMO_KEY && req.headers['x-demo-key'] !== env.DEMO_KEY) {
      return reply.code(401).send({ error: 'x-demo-key header required' });
    }
  });
  await new Promise<void>((resolve) =>
    conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
      tables.clock, tables.cashMovement, tables.workItem, tables.paymentApplication, tables.hold,
      tables.tieOutRun, tables.gatewayCommand, tables.auditEvent, tables.accessRequest, tables.custodyHolding, tables.invoice,
    ]),
  );
  const db = conn.db;
  const simDate = () => db.clock.id.find(1)?.simDate ?? env.SIM_DATE;

  /** Waits until this connection sees the movement (sync writes on another connection). */
  const awaitMovement = async (bankRef: string, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = [...db.cashMovement.bankRef.filter(bankRef)].find((x) => !x.isHistory);
      if (m && m.matchStatus !== 'unmatched') return m;
      if (Date.now() > deadline) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** What happened to one movement, in one response. */
  const outcome = (bankRef: string, startedAt: number) => {
    const m = [...db.cashMovement.bankRef.filter(bankRef)].find((x) => !x.isHistory);
    if (!m) return { bankRef, found: false, ms: Date.now() - startedAt };
    const applications = [...db.paymentApplication.movementId.filter(m.id)].filter((a) => !a.reversed);
    const items = [...db.workItem.iter()].filter((w) => w.subjectId === m.id);
    const holdReleases = [...db.auditEvent.iter()].filter((e) => e.action === 'HOLD_RELEASED' && e.detail.includes(m.bankRef));
    return {
      bankRef,
      found: true,
      ms: Date.now() - startedAt,
      bankText: m.memo,
      parsed: {
        category: m.category, network: m.network, payer: m.origName, account: m.origAccount, remittance: m.remittance,
        references: m.refs, confidence: m.parseConfidence, parsedBy: m.parsedBy, notes: m.parseNotes,
        hints: m.hintsJson ? JSON.parse(m.hintsJson) : undefined,
        instructedCents: m.instructedCents?.toString(), chargesCents: m.chargesCents?.toString(),
      },
      status: m.status,
      matchStatus: m.matchStatus,
      applications: applications.map((a) => ({ invoiceId: a.invoiceId, amountCents: a.amountCents.toString(), method: a.method, policy: a.policyRef })),
      workItems: items.map((w) => ({ id: w.id.toString(), kind: w.kind, state: w.state, title: w.title, reasoning: w.reasoning, policy: w.policyRef, needs: w.autoApplied ? null : w.requiredRole })),
      holdsReleased: holdReleases.map((e) => e.detail),
    };
  };

  app.post('/demo/inject', async (req, reply) => {
    const parsed = InjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const p = parsed.data;
    if (p.payer.clientId && !ds.clients.some((c) => c.id === p.payer.clientId)) return reply.code(400).send({ error: `unknown client ${p.payer.clientId}` });
    return receiveWire(p);
  });

  /**
   * The client portal's "Pay now": a real wire from the client's own Nessie account for everything
   * overdue, quoting the invoice numbers. Payment checking, hold release and the agents follow from it.
   */
  app.post('/demo/pay', async (req, reply) => {
    const parsed = PaySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { clientId } = parsed.data;
    if (!ds.clients.some((c) => c.id === clientId)) return reply.code(400).send({ error: `unknown client ${clientId}` });
    const today = simDate();
    const due = [...db.invoice.clientId.filter(clientId)].filter((i) => i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents);
    if (!due.length) return reply.code(409).send({ error: 'nothing is overdue' });
    const cents = due.reduce((s, i) => s + Number(i.amountCents - i.paidCents), 0);
    return receiveWire({
      payer: { clientId }, amount: cents / 100, remittance: `PAYMENT ${due.map((i) => i.id).join(' ')}`.slice(0, 140),
      network: 'FEDWIRE', charges: 0, status: 'posted',
    });
  });

  /** A wire lands in the platform's collections account at Nessie (and leaves the payer's, when we know them). */
  async function receiveWire(p: z.infer<typeof InjectSchema>) {
    const startedAt = Date.now();
    const client = p.payer.clientId ? ds.clients.find((c) => c.id === p.payer.clientId) : undefined;

    const count = [...db.cashMovement.iter()].filter((m) => m.bankRef.startsWith('JD-')).length;
    const trn = `JD-${String(count + 1).padStart(4, '0')}`;
    const name = p.payer.name ?? client!.legalName;
    const account = client ? bank.map.accounts[client.id]!.number : `9${String(Math.abs(hash(name))).padStart(15, '0').slice(0, 15)}`;
    const payerBank = client?.bank ?? (p.network === 'SWIFT' ? { name: 'HSBC BANK PLC', id: 'MIDLGB22', country: 'GB' } : { name: 'TRUIST BANK', id: '061000104', country: 'US' });
    // Known payers: the other side is recorded in their bank too.
    await postIncomingWire(bank, ds.platform.legalName, {
      trn, date: simDate(), payer: { name, account, bank: payerBank, accountKey: client?.id }, amountCents: toCents(p.amount),
      remittance: p.remittance, status: p.status === 'posted' ? 'completed' : 'pending',
      swift: p.network === 'SWIFT' ? { chargeBearer: 'SHA', chargesCents: toCents(p.charges) } : undefined,
    });
    await sync.cash(client ? [client.id] : []);
    await awaitMovement(trn);
    return outcome(trn, startedAt);
  }

  app.post('/demo/settle', async (req, reply) => {
    const bankRef = (req.body as { bankRef?: string } | undefined)?.bankRef ?? 'WI-5531';
    const movement = ds.movements.find((m) => m.id === bankRef);
    if (!movement) return reply.code(404).send({ error: `no seeded movement ${bankRef}` });
    if (movement.valueDate > simDate()) {
      return reply.code(409).send({ error: `${bankRef} is dated ${movement.valueDate}; the sim date is ${simDate()}. Advance the clock first.` });
    }
    const startedAt = Date.now();
    await settleWire(bank.api, bank.map, plan, bankRef);
    await sync.cash();
    await awaitMovement(bankRef);
    return outcome(bankRef, startedAt);
  });

  /** The client portal's withdraw button: decided instantly, the released part wired through Nessie. */
  app.post('/demo/withdraw', async (req, reply) => {
    const parsed = WithdrawSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { clientId, amount } = parsed.data;
    const startedAt = Date.now();
    const before = new Set([...db.accessRequest.clientId.filter(clientId)].map((r) => r.id));
    try {
      await conn.reducers.requestCustodyWithdrawal({ clientId, amountCents: BigInt(toCents(amount)) });
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : String(e) });
    }
    const request = [...db.accessRequest.clientId.filter(clientId)].find((r) => !before.has(r.id));
    if (!request) return reply.code(500).send({ error: 'request not visible yet' });
    const wireRef = request.allowedCents > 0n ? `CW-${String(request.id).padStart(4, '0')}` : undefined;
    const wire = wireRef ? await awaitMovement(wireRef, 8000) : undefined;
    return {
      decision: request.decision,
      requestedCents: request.amountCents.toString(),
      releasedCents: request.allowedCents.toString(),
      heldCents: request.heldCents.toString(),
      reason: request.reason,
      wire: wireRef ? { bankRef: wireRef, seen: !!wire, matchStatus: wire?.matchStatus ?? null } : null,
      custodyUsdCents: db.custodyHolding.id.find(`${clientId}:USD`)?.valueCents.toString() ?? null,
      ms: Date.now() - startedAt,
    };
  });

  /** Binds the browser's own identity to a client, so the portal views return only that client's rows. */
  app.post('/demo/portal-as', async (req, reply) => {
    const parsed = PortalAsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { clientId, identity } = parsed.data;
    try {
      await conn.reducers.bindPortal({ identityHex: identity, clientId });
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : String(e) });
    }
    return { clientId, identity };
  });

  app.post('/demo/advance', async (req, reply) => {
    const days = Number((req.body as { days?: number } | undefined)?.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 60) return reply.code(400).send({ error: 'days must be 1–60' });
    await conn.reducers.advanceClock({ days });
    await sync.cash(); // wires dated up to the new date become visible
    return { simDate: simDate() };
  });

  /** Let time run: one sim day every `secondsPerDay` (0 pauses), optionally stopping on `runUntil`. */
  app.post('/demo/clock', async (req, reply) => {
    const body = (req.body ?? {}) as { secondsPerDay?: number; runUntil?: string };
    const secondsPerDay = Number(body.secondsPerDay ?? 0);
    if (!Number.isInteger(secondsPerDay) || secondsPerDay < 0) return reply.code(400).send({ error: 'secondsPerDay must be a whole number ≥ 0' });
    try {
      await conn.reducers.setClockSpeed({ secondsPerDay, runUntil: body.runUntil });
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : String(e) });
    }
    return { simDate: simDate(), secondsPerDay, runUntil: body.runUntil ?? null };
  });

  app.post('/demo/reset', async () => {
    const startedAt = Date.now();
    const bankResult = await resetBank(bank.api, bank.map, plan);
    await conn.reducers.resetWorld({ simDate: env.SIM_DATE });
    platform.reset();
    sync.resetCaches();
    const results = await sync.full();
    await deps.gateway()?.drain();
    await conn.reducers.worldSettled({});
    return {
      simDate: simDate(),
      bank: bankResult,
      synced: results.map((r) => ({ source: r.source, written: r.written, errors: r.errors.length })),
      ms: Date.now() - startedAt,
    };
  });

  app.get('/demo/state', async () => {
    const latestTieOut = [...db.tieOutRun.iter()].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    const open = [...db.workItem.iter()].filter((w) => w.state === 'PROPOSED' || w.state === 'NEEDS_INFO');
    const recent = [...db.auditEvent.iter()]
      .filter((e) => !['COMMAND_QUEUED', 'COMMAND_DONE', 'CASH_RECONCILED'].includes(e.action))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, 15);
    return {
      simDate: simDate(),
      books: latestTieOut ? { status: latestTieOut.status, unexplainedCents: latestTieOut.unexplainedCents.toString(), trigger: latestTieOut.trigger } : null,
      needsYou: open.map((w) => ({ id: w.id.toString(), kind: w.kind, title: w.title, role: w.requiredRole })),
      gatewayPending: [...db.gatewayCommand.iter()].filter((c) => c.status === 'queued' || c.status === 'executing').length,
      recent: recent.map((e) => ({ action: e.action, detail: e.detail, policy: e.policyRef, simDate: e.simDate })),
    };
  });
}

function hash(s: string): number {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
