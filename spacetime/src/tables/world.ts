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
    /** 0 = paused. Otherwise the clock moves one sim day every this many real seconds. */
    secondsPerDay: t.u32(),
    /** A running clock stops on this date. */
    runUntil: t.string().optional(),
    updatedAt: t.timestamp(),
    /** A reset is reloading the world: agents claim no tasks until it is whole again. */
    settling: t.bool().default(false),
  },
);

/** Drives tick_clock once a second (scheduled reducer; one row). */
export const clockTick = table(
  {},
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
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
