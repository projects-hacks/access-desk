import { Identity } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import { addDays, audit, requireRole, simDate } from '../context';
import { CAN_MOVE_CLOCK, CAN_RESET, isRole } from '../roles';
import { spacetimedb } from '../schema';
import { seedBaselinePolicies } from './policies';
import { runTieOut } from '../books/tieout';

/** Runs on first publish (and after a data reset). The publisher becomes ADMIN. */
export const init = spacetimedb.init((ctx) => {
  ctx.db.platform.insert({
    id: 1,
    name: 'Northstar Prime',
    legalName: 'Northstar Prime Ltd',
    wireInstructions: '',
    autoApplyLimitCents: 5_000_000n,
  });
  ctx.db.clock.insert({ id: 1, simDate: '2026-03-03', updatedAt: ctx.timestamp });
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

/** Moves the shared simulated date forward and marks deadlines that fall due. */
export const advanceClock = spacetimedb.reducer({ days: t.u16() }, (ctx, { days }) => {
  requireRole(ctx, CAN_MOVE_CLOCK);
  const from = simDate(ctx);
  const to = addDays(from, days);
  ctx.db.clock.id.update({ id: 1, simDate: to, updatedAt: ctx.timestamp });
  for (const d of ctx.db.deadline.iter()) {
    if (d.status === 'open' && d.dueOn <= to) {
      ctx.db.deadline.id.update({ ...d, status: 'due' });
      audit(ctx, { action: 'DEADLINE_DUE', subjectType: 'deadline', subjectId: String(d.id), clientId: d.clientId, workItemId: d.workItemId, detail: d.kind });
    }
  }
  audit(ctx, { action: 'ADVANCE_CLOCK', subjectType: 'clock', subjectId: '1', fromState: from, toState: to });
  runTieOut(ctx, `clock advanced to ${to}`);
});

/** Demo reset: back to the morning of the demo. */
export const setClock = spacetimedb.reducer({ simDate: t.string() }, (ctx, args) => {
  requireRole(ctx, CAN_RESET);
  ctx.db.clock.id.update({ id: 1, simDate: args.simDate, updatedAt: ctx.timestamp });
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
  wipe(db.tieOutBreak.iter(), (r: { id: bigint }) => r.id, (k) => db.tieOutBreak.id.delete(k));
  wipe(db.auditEvent.iter(), (r: { id: bigint }) => r.id, (k) => db.auditEvent.id.delete(k));
  for (const p of [...db.policy.iter()]) if (p.learnedFrom !== 'baseline' && db.policy.key.delete(p.key)) rows++;
  seedBaselinePolicies(ctx);
  ctx.db.clock.id.update({ id: 1, simDate, updatedAt: ctx.timestamp });
  audit(ctx, { action: 'RESET_WORLD', subjectType: 'world', subjectId: '1', toState: simDate, detail: `${rows} rows removed` });
});
