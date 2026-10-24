import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  STDB_URI: z.string().default('wss://maincloud.spacetimedb.com'),
  STDB_DATABASE: z.string().default('access-desk-calhacks13'),
  /** Identity token for this service; keeps the same identity (and role) across restarts. */
  STDB_TOKEN: z.string().optional(),
  NESSIE_API_KEY: z.string().optional(),
  NESSIE_BASE_URL: z.string().default('https://prod-api.nessieisreal.com'),
  /** Which seeded run sync reads (.data/nessie-<run>.json). */
  NESSIE_RUN: z.string().default('dev'),
  /** `fake` swaps Nessie for the in-memory bank (tests, or if Nessie is down). */
  BANK_MODE: z.enum(['nessie', 'fake']).default('nessie'),
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
