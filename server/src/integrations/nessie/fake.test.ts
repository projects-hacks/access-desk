import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../../dataset';
import { FakeNessie } from './fake';
import { parseBankText } from '../bank-text/parse';
import { buildSeedPlan } from './seed-plan';

test('fake bank holds the full seed with the demo wire pending', async () => {
  const plan = buildSeedPlan(loadDataset());
  const { bank, map } = await FakeNessie.seeded(plan);

  assert.equal(Object.keys(map.accounts).length, plan.accounts.length);
  assert.equal(Object.keys(map.transactions).length, plan.transactions.length);

  const deposits = await bank.listDeposits(map.accounts.collections!.id);
  const zephyr = deposits.find((d) => parseBankText(d.description).bankRef === 'WI-5531');
  assert.equal(zephyr?.status, 'pending');
  assert.equal(zephyr?.amount, 14_820_000);
  assert.equal(parseBankText(zephyr!.description).counterpartyAccount, map.accounts['aff:zephyr']!.number);
});
