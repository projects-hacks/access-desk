import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import { wireIn } from '../integrations/bank-text/format';
import type { Bank } from '../integrations/nessie/bank';
import { resetBank, settleWire } from '../integrations/nessie/reset';
import { PLATFORM_BANK, type SeedPlan } from '../integrations/nessie/seed-plan';
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

const toCents = (dollars: number) => Math.round(dollars * 100);

/**
 * Demo controls, enabled with DEMO_CONTROLS=true. Every action goes through the
 * real path: Nessie writes, sync, payment checking, gateway, tie-out.
 */
export async function demoRoutes(app: FastifyInstance, deps: Deps) {
  const { conn, sync, bank, plan, ds, platform } = deps;
  await new Promise<void>((resolve) =>
    conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
      tables.clock, tables.cashMovement, tables.workItem, tables.paymentApplication, tables.hold,
      tables.tieOutRun, tables.gatewayCommand, tables.auditEvent,
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
    const startedAt = Date.now();
    const client = p.payer.clientId ? ds.clients.find((c) => c.id === p.payer.clientId) : undefined;
    if (p.payer.clientId && !client) return reply.code(400).send({ error: `unknown client ${p.payer.clientId}` });
    const collections = bank.map.accounts.collections;
    if (!collections) return reply.code(500).send({ error: 'collections account missing' });

    const count = [...db.cashMovement.iter()].filter((m) => m.bankRef.startsWith('JD-')).length;
    const trn = `JD-${String(count + 1).padStart(4, '0')}`;
    const name = p.payer.name ?? client!.legalName;
    const account = client ? bank.map.accounts[client.id]!.number : `9${String(Math.abs(hash(name))).padStart(15, '0').slice(0, 15)}`;
    const payerBank = client?.bank ?? (p.network === 'SWIFT' ? { name: 'HSBC BANK PLC', id: 'MIDLGB22', country: 'GB' } : { name: 'TRUIST BANK', id: '061000104', country: 'US' });
    const receivedCents = toCents(p.amount);
    const chargesCents = p.network === 'SWIFT' ? toCents(p.charges) : 0;
    const description = wireIn({
      trn, date: simDate(), orig: name, origAccount: account, bank: payerBank, remittance: p.remittance,
      international: p.network === 'SWIFT' ? { uetr: crypto.randomUUID(), instructedCents: receivedCents + chargesCents, chargeBearer: 'SHA', chargesCents } : undefined,
    });
    const status = p.status === 'posted' ? 'completed' : 'pending';
    await bank.api.createDeposit(collections.id, { medium: 'balance', transaction_date: simDate(), status, amount: receivedCents, description });
    // Known payers: record the other side in their bank too.
    if (client) {
      await bank.api.createWithdrawal(bank.map.accounts[client.id]!.id, {
        medium: 'balance', transaction_date: simDate(), status: 'completed', amount: receivedCents + chargesCents,
        description: `WIRE TYPE:FED OUT TRN:${trn} BNF:${ds.platform.legalName.toUpperCase()} ID:${collections.number} RCV BK:${PLATFORM_BANK.name} PMT DET:${p.remittance.toUpperCase()}`,
      });
    }
    await sync.cash();
    await awaitMovement(trn);
    return outcome(trn, startedAt);
  });

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

  app.post('/demo/advance', async (req, reply) => {
    const days = Number((req.body as { days?: number } | undefined)?.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 60) return reply.code(400).send({ error: 'days must be 1–60' });
    await conn.reducers.advanceClock({ days });
    await sync.cash(); // wires dated up to the new date become visible
    return { simDate: simDate() };
  });

  app.post('/demo/reset', async () => {
    const startedAt = Date.now();
    const bankResult = await resetBank(bank.api, bank.map, plan);
    await conn.reducers.resetWorld({ simDate: env.SIM_DATE });
    platform.reset();
    sync.resetCaches();
    const results = await sync.full();
    await deps.gateway()?.drain();
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
