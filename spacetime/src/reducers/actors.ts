import { SenderError, t } from 'spacetimedb/server';
import { isRole } from '../roles';
import { spacetimedb } from '../schema';

// TODO: restrict who may assign roles (today any caller registers itself).
export const registerActor = spacetimedb.reducer(
  { name: t.string(), role: t.string() },
  (ctx, { name, role }) => {
    if (!isRole(role)) throw new SenderError(`Unknown role: ${role}`);
    const existing = ctx.db.actor.identity.find(ctx.sender);
    if (existing) ctx.db.actor.identity.update({ ...existing, name, role });
    else ctx.db.actor.insert({ identity: ctx.sender, name, role });
  },
);
