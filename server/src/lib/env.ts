import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  STDB_URI: z.string().default('ws://localhost:3000'),
  STDB_DATABASE: z.string().default('access-desk'),
  ANTHROPIC_API_KEY: z.string().optional(),
  NESSIE_API_KEY: z.string().optional(),
  NESSIE_BASE_URL: z.string().default('http://api.nessieisreal.com'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed once at startup; fails fast on bad config. */
export const env: Env = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
})();
