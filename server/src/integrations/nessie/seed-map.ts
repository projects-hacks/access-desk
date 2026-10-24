import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountKey } from './seed-plan';

export const DATA_DIR = join(import.meta.dirname, '../../../../.data');

/** Nessie ids created by one seed run, keyed by our own ids. */
export interface SeedMap {
  run: string;
  startedAt: string;
  baseUrl: string;
  customers: Record<string, string>;
  accounts: Record<AccountKey, { id: string; number: string }>;
  bills: Record<string, string>;
  /** Keyed `<movementId>:platform` or `<movementId>:counterparty`. */
  transactions: Record<string, string>;
}

export const seedMapPath = (run: string) => join(DATA_DIR, `nessie-${run}.json`);

export function emptySeedMap(run: string, baseUrl: string): SeedMap {
  return { run, startedAt: new Date().toISOString(), baseUrl, customers: {}, accounts: {}, bills: {}, transactions: {} };
}

export function readSeedMap(run: string): SeedMap {
  return JSON.parse(readFileSync(seedMapPath(run), 'utf8'));
}

export function writeSeedMap(map: SeedMap): void {
  writeFileSync(seedMapPath(map.run), JSON.stringify(map, null, 2));
}
