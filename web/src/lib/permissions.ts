import type { Permission } from '../module_bindings/types';
import type { ClientRow } from './clients';

/** Fine-grained permissions under each lever; mirrors PERMISSIONS in spacetime/src/permissions.ts. */
export const PERMISSION_GROUPS = [
  {
    lever: 'withdrawals',
    name: 'Custody',
    items: [
      { key: 'crypto_withdrawals', name: 'Crypto withdrawals' },
      { key: 'fiat_withdrawals', name: 'Fiat withdrawals' },
      { key: 'transfers', name: 'Transfers between portfolios' },
      { key: 'staking', name: 'Staking' },
    ],
  },
  {
    lever: 'trading',
    name: 'Trading',
    items: [
      { key: 'buy', name: 'Buy' },
      { key: 'sell', name: 'Sell' },
      { key: 'derivatives', name: 'Derivatives' },
      { key: 'otc', name: 'OTC desk' },
    ],
  },
  { lever: 'api', name: 'API', items: [{ key: 'api', name: 'API access' }] },
  { lever: 'financing', name: 'Borrowing', items: [{ key: 'borrowing', name: 'New borrowing' }] },
] as const;

/** Whether a permission is on: its own row, or else whether its lever is fully on. */
export function permissionOn(
  row: ClientRow,
  permissions: readonly Permission[],
  key: string,
  lever: string,
): boolean {
  const own = permissions.find((p) => p.clientId === row.client.id && p.key === key);
  if (own) return own.enabled;
  return row.levers.find((l) => l.key === lever)?.state === 'active';
}
