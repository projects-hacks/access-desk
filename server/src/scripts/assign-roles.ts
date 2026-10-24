/**
 * Re-assigns service roles after a database reset (the publisher is ADMIN automatically).
 * Reads identities from the tokens in .env. Usage: pnpm stdb:roles
 */
import { execFileSync } from 'node:child_process';
import { env } from '../lib/env';

const identityOf = (token: string) => {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
  if (typeof payload.hex_identity !== 'string') throw new Error('token has no hex_identity claim');
  return payload.hex_identity as string;
};

const services = [
  { token: env.STDB_TOKEN, name: 'sync-service', role: 'SYNC' },
  { token: env.STDB_GATEWAY_TOKEN, name: 'gateway', role: 'GATEWAY' },
  { token: env.STDB_DEMO_TOKEN, name: 'demo-controls', role: 'DEMO' },
  { token: process.env.STDB_AGENT_TOKEN, name: 'agents', role: 'AGENT' },
  // The web console approves as a controller (agents propose under their own identity).
  { token: process.env.VITE_STDB_CONTROLLER_TOKEN, name: 'ui-controller', role: 'CONTROLLER' },
];

for (const s of services) {
  if (!s.token) {
    console.log(`skip ${s.name}: no token in .env`);
    continue;
  }
  const identity = identityOf(s.token);
  execFileSync('spacetime', [
    'call', '-s', 'maincloud', env.STDB_DATABASE, 'assign_role', JSON.stringify(identity), JSON.stringify(s.name), JSON.stringify(s.role), 'null',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`${s.name}: ${s.role} (${identity.slice(0, 12)}…)`);
}
