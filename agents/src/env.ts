/** Read once at startup from the repo-root .env (via tsx --env-file) and the process environment. */
export const env = {
  STDB_URI: process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com',
  STDB_DATABASE: process.env.STDB_DATABASE ?? 'access-desk-calhacks13',
  /** The agents' identity (role AGENT). */
  STDB_AGENT_TOKEN: process.env.STDB_AGENT_TOKEN,
  FACTORY_API_KEY: process.env.FACTORY_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  /** The model behind Droid and the Claude fallback. */
  LLM_MODEL: process.env.LLM_MODEL ?? 'claude-opus-5-5',
  /** The agents act on the shared database, so exactly one process may run them: the hosted one sets this. */
  AGENTS_HOST: process.env.AGENTS_HOST === 'true',
};
