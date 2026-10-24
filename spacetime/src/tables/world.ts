import { table, t } from 'spacetimedb/server';

/** Single row (id = 1). Rename the platform here. */
export const platform = table(
  { public: true },
  {
    id: t.u8().primaryKey(),
    name: t.string(),
    legalName: t.string(),
    wireInstructions: t.string(),
    autoApplyLimitCents: t.i64(),
  },
);

/** Single row (id = 1). The shared simulated date every rule is evaluated against. */
export const clock = table(
  { public: true },
  {
    id: t.u8().primaryKey(),
    simDate: t.string(),
    updatedAt: t.timestamp(),
  },
);

export const actor = table(
  { public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    role: t.string(),
    clientId: t.string().optional(),
  },
);
