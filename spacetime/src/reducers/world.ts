import { Identity } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import { addDays, audit, requireRole, simDate } from '../context';
import { CAN_MOVE_CLOCK, isRole } from '../roles';
import { spacetimedb } from '../schema';

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
});

/** Demo reset: back to the morning of the demo. */
export const setClock = spacetimedb.reducer({ simDate: t.string() }, (ctx, args) => {
  requireRole(ctx, ['ADMIN']);
  ctx.db.clock.id.update({ id: 1, simDate: args.simDate, updatedAt: ctx.timestamp });
  audit(ctx, { action: 'SET_CLOCK', subjectType: 'clock', subjectId: '1', toState: args.simDate });
});
