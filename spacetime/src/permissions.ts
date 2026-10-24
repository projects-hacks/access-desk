/**
 * Fine-grained permissions a controller can switch, each under one of the four levers.
 * Pure, so it is unit-tested; reducers/manual.ts applies it.
 */

export const PERMISSIONS = [
  { key: 'crypto_withdrawals', lever: 'withdrawals', name: 'Crypto withdrawals' },
  { key: 'fiat_withdrawals', lever: 'withdrawals', name: 'Fiat withdrawals' },
  { key: 'transfers', lever: 'withdrawals', name: 'Transfers between portfolios' },
  { key: 'staking', lever: 'withdrawals', name: 'Staking' },
  { key: 'buy', lever: 'trading', name: 'Buy' },
  { key: 'sell', lever: 'trading', name: 'Sell' },
  { key: 'derivatives', lever: 'trading', name: 'Derivatives' },
  { key: 'otc', lever: 'trading', name: 'OTC desk' },
  { key: 'api', lever: 'api', name: 'API' },
  { key: 'borrowing', lever: 'financing', name: 'Borrowing' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

/** With these all off, the lever is off; anything less is limited. */
const CORE: Record<string, readonly string[]> = {
  withdrawals: ['crypto_withdrawals', 'fiat_withdrawals'],
  trading: ['buy', 'sell'],
  api: ['api'],
  financing: ['borrowing'],
};

export const isPermission = (key: string): key is PermissionKey => PERMISSIONS.some((p) => p.key === key);

/** The lever summary (state, detail) from its permissions' on/off values. */
export function leverSummary(lever: string, enabled: (key: PermissionKey) => boolean): { state: 'active' | 'limited' | 'off'; detail: string } {
  const own = PERMISSIONS.filter((p) => p.lever === lever);
  const off = own.filter((p) => !enabled(p.key));
  if (!off.length) return { state: 'active', detail: 'All on' };
  const core = CORE[lever] ?? [];
  const state = core.every((k) => off.some((p) => p.key === k)) ? 'off' : 'limited';
  return { state, detail: `${off.map((p) => p.name).join(', ')} off` };
}

/** Why a person (a second controller) must approve, or undefined when it applies at once. */
export function permissionNeedsHuman(i: { tier: number; strategic: boolean; changes: { key: string; enabled: boolean }[] }): string | undefined {
  // Giving access back never waits.
  if (i.changes.every((c) => c.enabled)) return undefined;
  if (i.strategic) return 'strategic client';
  if (i.tier <= 2) return `tier ${i.tier} client`;
  // pol-008 in spirit: a client who can't sell can't unwind or hedge.
  if (i.changes.some((c) => c.key === 'sell' && !c.enabled)) return 'turning off sell can trap open positions';
  return undefined;
}
