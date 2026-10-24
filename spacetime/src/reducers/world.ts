import { Identity, ScheduleAt } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import { addDays, audit, requireRole, simDate, type Ctx } from '../context';
import { CAN_MOVE_CLOCK, CAN_RESET, isRole } from '../roles';
import { spacetimedb } from '../schema';
import { seedBaselinePolicies } from './policies';
import { runTieOut } from '../books/tieout';
import { evaluateDeadlines } from '../payments/deadlines';
import { clockTick } from '../tables/world';
import { sendDefaultNotices } from './actions';
import { requeueStuckCommands } from '../payments/gateway';

/** Runs on first publish (and after a data reset). The publisher becomes ADMIN. */
export const init = spacetimedb.init((ctx) => {
  ctx.db.platform.insert({
    id: 1,
    name: 'Northstar Prime',
    legalName: 'Northstar Prime Ltd',
    wireInstructions: '',
    autoApplyLimitCents: 5_000_000n,
  });
  ctx.db.clock.insert({ id: 1, simDate: '2026-03-03', secondsPerDay: 0, runUntil: undefined, updatedAt: ctx.timestamp });
  ensureTicker(ctx);
  ctx.db.actor.insert({ identity: ctx.sender, name: 'owner', role: 'ADMIN', clientId: undefined });
  seedBaselinePolicies(ctx);
});

export const setPlatform = spacetimedb.reducer(
  { name: t.string(), legalName: t.string(), wireInstructions: t.string(), autoApplyLimitCents: t.i64() },
  (ctx, args) => {
    // Sync applies the platform name from configuration, so a rename is one env change.
    requireRole(ctx, ['ADMIN', 'SYNC']);
    const current = ctx.db.platform.id.find(1);
    if (current && current.name === args.name && current.legalName === args.legalName
      && current.wireInstructions === args.wireInstructions && current.autoApplyLimitCents === args.autoApplyLimitCents) return;
    ctx.db.platform.id.update({ id: 1, ...args });
    audit(ctx, { action: 'SET_PLATFORM', subjectType: 'platform', subjectId: '1', detail: args.name });
  },
);

/** Only ADMIN grants roles. Services get an identity once, then the owner assigns its role. */
export const assignRole = spacetimedb.reducer(
  { identityHex: t.string(), name: t.string(), role: t.string(), clientId: t.string().optional() },
  (ctx, { identityHex, name, role, clientId }) => {
    requireRole(ctx, ['ADMIN']);
    if (!isRole(role)) throw new SenderError(`unknown role ${role}`);
    const identity = Identity.fromString(identityHex);
    const row = { identity, name, role, clientId };
    if (ctx.db.actor.identity.find(identity)) ctx.db.actor.identity.update(row);
    else ctx.db.actor.insert(row);
    audit(ctx, { action: 'ASSIGN_ROLE', subjectType: 'actor', subjectId: identityHex, toState: role, detail: name });
  },
);

// ── Time ────────────────────────────────────────────────────────────────────

const MAX_SECONDS_PER_DAY = 3600;

function ensureTicker(ctx: Ctx) {
  if (ctx.db.clockTick.count() === 0n) ctx.db.clockTick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
}

/**
 * One sim day passes: deadlines resolve, clients newly past their grace period
 * get a default notice (pol-007). Days are stepped one at a time so every
 * notice and deadline carries the day it really happened.
 */
function moveClock(ctx: Ctx, days: number, trigger: string) {
  const from = simDate(ctx);
  for (let i = 0; i < days; i++) {
    const c = ctx.db.clock.id.find(1)!;
    const to = addDays(c.simDate, 1);
    const stop = !!c.runUntil && to >= c.runUntil;
    ctx.db.clock.id.update({ ...c, simDate: to, secondsPerDay: stop ? 0 : c.secondsPerDay, runUntil: stop ? undefined : c.runUntil, updatedAt: ctx.timestamp });
    evaluateDeadlines(ctx);
    sendDefaultNotices(ctx);
    if (stop) break;
  }
  const to = simDate(ctx);
  audit(ctx, { action: 'ADVANCE_CLOCK', subjectType: 'clock', subjectId: '1', fromState: from, toState: to, detail: trigger });
  runTieOut(ctx, `clock moved to ${to}`);
}

/** Jump the shared simulated date forward. */
export const advanceClock = spacetimedb.reducer({ days: t.u16() }, (ctx, { days }) => {
  requireRole(ctx, CAN_MOVE_CLOCK);
  if (days < 1 || days > 60) throw new SenderError('days must be 1–60');
  moveClock(ctx, days, `advanced ${days} day(s)`);
});

/** Let time run on its own: one sim day every `secondsPerDay` (0 pauses), optionally until a date. */
export const setClockSpeed = spacetimedb.reducer(
  { secondsPerDay: t.u32(), runUntil: t.string().optional() },
  (ctx, { secondsPerDay, runUntil }) => {
    requireRole(ctx, CAN_MOVE_CLOCK);
    if (secondsPerDay > MAX_SECONDS_PER_DAY) throw new SenderError(`at most ${MAX_SECONDS_PER_DAY} seconds per day`);
    const c = ctx.db.clock.id.find(1)!;
    if (runUntil && !(/^\d{4}-\d{2}-\d{2}$/.test(runUntil) && runUntil > c.simDate)) throw new SenderError(`runUntil must be a date after ${c.simDate}`);
    ctx.db.clock.id.update({ ...c, secondsPerDay, runUntil: secondsPerDay ? runUntil : undefined, updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'CLOCK_SPEED', subjectType: 'clock', subjectId: '1', toState: secondsPerDay ? 'running' : 'paused',
      detail: secondsPerDay ? `1 day every ${secondsPerDay}s${runUntil ? ` until ${runUntil}` : ''}` : 'paused',
    });
  },
);

/** Scheduled every second: moves a running clock, and puts back commands a crashed gateway left mid-flight. */
export const tickClock = spacetimedb.reducer({ onSchedule: clockTick }, { tick: clockTick.rowType }, (ctx) => {
  const c = ctx.db.clock.id.find(1);
  if (c && c.secondsPerDay > 0 && ctx.timestamp.microsSinceUnixEpoch - c.updatedAt.microsSinceUnixEpoch >= BigInt(c.secondsPerDay) * 1_000_000n) {
    moveClock(ctx, 1, 'clock running');
  }
  requeueStuckCommands(ctx);
});

/** Demo reset: back to the morning of the demo. */
export const setClock = spacetimedb.reducer({ simDate: t.string() }, (ctx, args) => {
  requireRole(ctx, CAN_RESET);
  ctx.db.clock.id.update({ id: 1, simDate: args.simDate, secondsPerDay: 0, runUntil: undefined, updatedAt: ctx.timestamp });
  audit(ctx, { action: 'SET_CLOCK', subjectType: 'clock', subjectId: '1', toState: args.simDate });
});

/**
 * Wipes the world back to before the first sync: every synced row and every
 * decision, command, journal and audit row. Keeps roles, the platform row and
 * baseline policies; resets the clock. Sync then re-imports and re-matches.
 */
export const resetWorld = spacetimedb.reducer({ simDate: t.string() }, (ctx, { simDate }) => {
  requireRole(ctx, CAN_RESET);
  const db = ctx.db;
  let rows = 0;
  const wipe = <K>(iter: Iterable<{ [k: string]: unknown }>, key: (r: never) => K, del: (k: K) => boolean) => {
    for (const r of [...iter]) if (del(key(r as never))) rows++;
  };
  wipe(db.syncSource.iter(), (r: { source: string }) => r.source, (k) => db.syncSource.source.delete(k));
  wipe(db.rawRecord.iter(), (r: { id: string }) => r.id, (k) => db.rawRecord.id.delete(k));
  wipe(db.client.iter(), (r: { id: string }) => r.id, (k) => db.client.id.delete(k));
  wipe(db.payerIdentity.iter(), (r: { id: string }) => r.id, (k) => db.payerIdentity.id.delete(k));
  wipe(db.contract.iter(), (r: { clientId: string }) => r.clientId, (k) => db.contract.clientId.delete(k));
  wipe(db.contractClause.iter(), (r: { id: string }) => r.id, (k) => db.contractClause.id.delete(k));
  wipe(db.capability.iter(), (r: { id: string }) => r.id, (k) => db.capability.id.delete(k));
  wipe(db.accessLever.iter(), (r: { id: string }) => r.id, (k) => db.accessLever.id.delete(k));
  wipe(db.invoice.iter(), (r: { id: string }) => r.id, (k) => db.invoice.id.delete(k));
  wipe(db.dispute.iter(), (r: { id: string }) => r.id, (k) => db.dispute.id.delete(k));
  wipe(db.cashMovement.iter(), (r: { id: string }) => r.id, (k) => db.cashMovement.id.delete(k));
  wipe(db.paymentApplication.iter(), (r: { id: bigint }) => r.id, (k) => db.paymentApplication.id.delete(k));
  wipe(db.clientCredit.iter(), (r: { id: bigint }) => r.id, (k) => db.clientCredit.id.delete(k));
  wipe(db.ledgerEntry.iter(), (r: { id: string }) => r.id, (k) => db.ledgerEntry.id.delete(k));
  wipe(db.custodyHolding.iter(), (r: { id: string }) => r.id, (k) => db.custodyHolding.id.delete(k));
  wipe(db.assetPrice.iter(), (r: { asset: string }) => r.asset, (k) => db.assetPrice.asset.delete(k));
  wipe(db.hold.iter(), (r: { id: bigint }) => r.id, (k) => db.hold.id.delete(k));
  wipe(db.owedToClient.iter(), (r: { id: string }) => r.id, (k) => db.owedToClient.id.delete(k));
  wipe(db.position.iter(), (r: { id: string }) => r.id, (k) => db.position.id.delete(k));
  wipe(db.loan.iter(), (r: { id: string }) => r.id, (k) => db.loan.id.delete(k));
  wipe(db.workItem.iter(), (r: { id: bigint }) => r.id, (k) => db.workItem.id.delete(k));
  wipe(db.decision.iter(), (r: { id: bigint }) => r.id, (k) => db.decision.id.delete(k));
  wipe(db.investigationStep.iter(), (r: { id: bigint }) => r.id, (k) => db.investigationStep.id.delete(k));
  wipe(db.rmNote.iter(), (r: { id: bigint }) => r.id, (k) => db.rmNote.id.delete(k));
  wipe(db.notice.iter(), (r: { id: bigint }) => r.id, (k) => db.notice.id.delete(k));
  wipe(db.gatewayCommand.iter(), (r: { id: bigint }) => r.id, (k) => db.gatewayCommand.id.delete(k));
  wipe(db.accessRequest.iter(), (r: { id: bigint }) => r.id, (k) => db.accessRequest.id.delete(k));
  wipe(db.deadline.iter(), (r: { id: bigint }) => r.id, (k) => db.deadline.id.delete(k));
  wipe(db.agentRun.iter(), (r: { id: bigint }) => r.id, (k) => db.agentRun.id.delete(k));
  wipe(db.creditProfile.iter(), (r: { clientId: string }) => r.clientId, (k) => db.creditProfile.clientId.delete(k));
  wipe(db.precedent.iter(), (r: { id: string }) => r.id, (k) => db.precedent.id.delete(k));
  wipe(db.exploitFlag.iter(), (r: { id: string }) => r.id, (k) => db.exploitFlag.id.delete(k));
  wipe(db.metricSnapshot.iter(), (r: { id: string }) => r.id, (k) => db.metricSnapshot.id.delete(k));
  wipe(db.tieOutRun.iter(), (r: { id: bigint }) => r.id, (k) => db.tieOutRun.id.delete(k));
  wipe(db.bankAccount.iter(), (r: { id: string }) => r.id, (k) => db.bankAccount.id.delete(k));
  wipe(db.tieOutBreak.iter(), (r: { id: bigint }) => r.id, (k) => db.tieOutBreak.id.delete(k));
  wipe(db.auditEvent.iter(), (r: { id: bigint }) => r.id, (k) => db.auditEvent.id.delete(k));
  for (const p of [...db.policy.iter()]) if (p.learnedFrom !== 'baseline' && db.policy.key.delete(p.key)) rows++;
  seedBaselinePolicies(ctx);
  ctx.db.clock.id.update({ id: 1, simDate, secondsPerDay: 0, runUntil: undefined, updatedAt: ctx.timestamp });
  ensureTicker(ctx);
  audit(ctx, { action: 'RESET_WORLD', subjectType: 'world', subjectId: '1', toState: simDate, detail: `${rows} rows removed` });
});
