import { loadDataset } from '../../dataset';
import { env } from '../../lib/env';
import { NessieClient, type NessieApi } from './client';
import { FakeNessie } from './fake';
import { readSeedMap, type SeedMap } from './seed-map';
import { buildSeedPlan } from './seed-plan';

/** The bank this process talks to, and the ids of the seeded run in it. */
export interface Bank {
  api: NessieApi;
  map: SeedMap;
  mode: 'nessie' | 'fake';
}

export async function openBank(): Promise<Bank> {
  if (env.BANK_MODE === 'fake') {
    const { bank, map } = await FakeNessie.seeded(buildSeedPlan(loadDataset()));
    return { api: bank, map, mode: 'fake' };
  }
  if (!env.NESSIE_API_KEY) throw new Error('NESSIE_API_KEY is not set (or use BANK_MODE=fake)');
  return { api: new NessieClient(env.NESSIE_BASE_URL, env.NESSIE_API_KEY), map: readSeedMap(env.NESSIE_RUN), mode: 'nessie' };
}
