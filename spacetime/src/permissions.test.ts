import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leverSummary, permissionNeedsHuman, type PermissionKey } from './permissions';

const offOnly = (...keys: PermissionKey[]) => (k: PermissionKey) => !keys.includes(k);

test('a lever with every permission on is active', () => {
  assert.deepEqual(leverSummary('trading', () => true), { state: 'active', detail: 'All on' });
});

test('buy off, sell on keeps trading limited (the hedge-preserving move)', () => {
  assert.deepEqual(leverSummary('trading', offOnly('buy')), { state: 'limited', detail: 'Buy off' });
});

test('the lever is off only when its core permissions are all off', () => {
  assert.equal(leverSummary('withdrawals', offOnly('crypto_withdrawals')).state, 'limited');
  assert.equal(leverSummary('withdrawals', offOnly('crypto_withdrawals', 'fiat_withdrawals')).state, 'off');
  assert.equal(leverSummary('api', offOnly('api')).state, 'off');
});

test('giving access back never waits for a person', () => {
  assert.equal(permissionNeedsHuman({ strategic: true, offboards: false, changes: [{ key: 'buy', enabled: true }] }), undefined);
});

test('only strategic clients and offboarding need a second controller', () => {
  const off = [{ key: 'buy', enabled: false }];
  assert.match(permissionNeedsHuman({ strategic: true, offboards: false, changes: off }) ?? '', /strategic/);
  assert.match(permissionNeedsHuman({ strategic: false, offboards: true, changes: off }) ?? '', /offboarding/);
  assert.equal(permissionNeedsHuman({ strategic: false, offboards: false, changes: off }), undefined);
  assert.equal(permissionNeedsHuman({ strategic: false, offboards: false, changes: [{ key: 'sell', enabled: false }] }), undefined);
});
