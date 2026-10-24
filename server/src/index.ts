import { env } from './lib/env';
import { buildApp } from './app';
import { startSync } from './sync';
import { BillingSource } from './sync/sources/billing';
import { NessieSource } from './sync/sources/nessie';

const app = buildApp();
await app.listen({ port: env.PORT, host: '0.0.0.0' });
const log = (msg: string) => app.log.info(msg);

startSync(
  [
    new BillingSource(`http://localhost:${env.PORT}/sim`),
    new NessieSource(env.NESSIE_BASE_URL, env.NESSIE_API_KEY),
  ],
  log,
);

