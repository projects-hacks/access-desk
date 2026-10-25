import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  STDB_URI: z.string().default('wss://maincloud.spacetimedb.com'),
  STDB_DATABASE: z.string().default('access-desk-calhacks13'),
  /** Identity token for this service; keeps the same identity (and role) across restarts. */
  STDB_TOKEN: z.string().optional(),
  /** Gateway identity (role GATEWAY): the only writer to systems of record. */
  STDB_GATEWAY_TOKEN: z.string().optional(),
  /** Demo identity (role DEMO): moves the clock and resets the world from the demo panel. */
  STDB_DEMO_TOKEN: z.string().optional(),
  /**
   * The server runs sync and the gateway against the shared database, so exactly
   * one may run (the hosted one). Set only there, or locally via pnpm dev:server
   * when the hosted one is stopped.
   */
  SERVER_HOST: z.stringbool().default(false),
  /** Turns on /demo/* endpoints (inject, settle, advance, reset, state). */
  DEMO_CONTROLS: z.stringbool().default(false),
  /** When set, demo POSTs need header x-demo-key with this value (the hosted server is public). */
  DEMO_KEY: z.string().optional(),
  /** Where the gateway reaches the platform's write APIs. Defaults to this server. */
  PLATFORM_API_URL: z.string().optional(),
  NESSIE_API_KEY: z.string().optional(),
  /** Enables Claude for free-text remittance; without it, rules only. */
  ANTHROPIC_API_KEY: z.string().optional(),
  NESSIE_BASE_URL: z.string().default('https://prod-api.nessieisreal.com'),
  /** Which seeded run sync reads (.data/nessie-<run>.json). */
  NESSIE_RUN: z.string().default('dev'),
  /** `fake` swaps Nessie for the in-memory bank (tests, or if Nessie is down). */
  BANK_MODE: z.enum(['nessie', 'fake']).default('nessie'),
  /** The platform lives on its own: sim clock, monthly billing, client payments, trades and withdrawals (world/). SERVER_HOST only. */
  WORLD_EVENTS: z.stringbool().default(false),
  /** Real seconds per simulated day; the clock is kept at this pace (0 = leave the clock alone). */
  WORLD_SECONDS_PER_DAY: z.coerce.number().int().min(0).max(3600).default(240),
  /** A client event every this many real seconds, jittered between min and max. */
  WORLD_EVENT_MIN_SECONDS: z.coerce.number().positive().default(20),
  WORLD_EVENT_MAX_SECONDS: z.coerce.number().positive().default(60),
  /** At most this many events per client per simulated day. */
  WORLD_CLIENT_DAY_CAP: z.coerce.number().int().min(1).default(2),
  /** Nessie writes the world may make per minute. */
  WORLD_BANK_WRITES_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** A paused clock is put back to speed after this long (a short pause by a person is respected). */
  WORLD_PAUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(300),
  PLATFORM_NAME: z.string().default('Northstar Prime'),
  PLATFORM_LEGAL_NAME: z.string().default('Northstar Prime Ltd'),
  SIM_DATE: z.iso.date().default('2026-03-03'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed once at startup; fails fast on bad config. */
export const env: Env = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
})();
