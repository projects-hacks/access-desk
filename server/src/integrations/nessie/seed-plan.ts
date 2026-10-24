import type { Address } from './client';
import { formatMemo } from './memo';
import type { BankMovement, Dataset, Party } from '../../dataset';

/**
 * Turns the dataset into the exact Nessie records to create. Account numbers
 * are only known after accounts exist, so memos take a resolver.
 */
export type AccountKey = string;

export interface CustomerPlan {
  key: string;
  first_name: string;
  last_name: string;
  address: Address;
}

export interface AccountPlan {
  key: AccountKey;
  customerKey: string;
  nickname: string;
}

export interface BillPlan {
  key: string;
  accountKey: AccountKey;
  status: 'pending' | 'completed';
  payee: string;
  nickname: string;
  payment_date: string;
  recurring_date: number;
  payment_amount: number;
}

export interface TransactionPlan {
  key: string;
  movementId: string;
  side: 'platform' | 'counterparty';
  accountKey: AccountKey;
  type: 'deposit' | 'withdrawal';
  status: 'pending' | 'completed';
  transaction_date: string;
  amount: number;
  describe: (accountNumber: (key: AccountKey) => string) => string;
}

export interface SeedPlan {
  customers: CustomerPlan[];
  accounts: AccountPlan[];
  bills: BillPlan[];
  transactions: TransactionPlan[];
}

const STREETS = ['Market St', 'Wacker Dr', 'Park Ave', 'Congress Ave', 'Brickell Ave', 'Boylston St', 'Pine St', 'Main St'];

function address(seed: string, city: string, state: string): Address {
  let h = 7;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 100_000;
  return {
    street_number: String(100 + (h % 1800)),
    street_name: STREETS[h % STREETS.length] ?? 'Main St',
    city,
    state,
    zip: String(10000 + (h % 89999)).padStart(5, '0'),
  };
}

export function partyAccountKey(party: Party): AccountKey {
  if (party.type === 'affiliate') return `aff:${party.key}`;
  return party.account === 'secondary' ? `${party.id}:secondary` : party.id;
}

export function buildSeedPlan(ds: Dataset): SeedPlan {
  const { platform } = ds;
  const customers: CustomerPlan[] = [
    { key: 'platform', first_name: platform.legalName, last_name: 'PLATFORM', address: address('platform', 'New York', 'NY') },
    ...ds.clients.map((c) => ({ key: c.id, first_name: c.legalName, last_name: c.id, address: address(c.id, c.city, c.state) })),
    ...ds.affiliates.map((a) => {
      const parent = ds.clients.find((c) => c.id === a.parentId);
      return { key: `aff:${a.key}`, first_name: a.legalName, last_name: a.parentId, address: address(a.key, parent?.city ?? 'New York', parent?.state ?? 'NY') };
    }),
  ];

  const secondary = new Set(
    ds.movements.flatMap((m) => (m.party?.type === 'client' && m.party.account === 'secondary' ? [m.party.id] : [])),
  );
  const accounts: AccountPlan[] = [
    { key: 'collections', customerKey: 'platform', nickname: `${platform.name} · Collections` },
    { key: 'disbursements', customerKey: 'platform', nickname: `${platform.name} · Disbursements` },
    ...ds.clients.map((c) => ({ key: c.id, customerKey: c.id, nickname: `${c.name} · Operating` })),
    ...[...secondary].map((id) => {
      const c = ds.clients.find((x) => x.id === id);
      return { key: `${id}:secondary`, customerKey: id, nickname: `${c?.name ?? id} · Treasury (new)` };
    }),
    ...ds.affiliates.map((a) => ({ key: `aff:${a.key}`, customerKey: `aff:${a.key}`, nickname: `${a.legalName} · Operating` })),
  ];

  // Invoices presented to each client's bank: everything issued in the bank window plus anything still unpaid.
  const bills: BillPlan[] = ds.invoices
    .filter((i) => i.issuedOn >= ds.bankWindowStart || i.status !== 'paid')
    .map((i) => ({
      key: i.id,
      accountKey: i.clientId,
      status: i.status === 'paid' ? 'completed' : 'pending',
      payee: platform.legalName,
      nickname: `${i.id} · ${i.label} · ${i.period}`,
      payment_date: i.dueOn,
      recurring_date: Number(i.dueOn.slice(8, 10)),
      payment_amount: i.amountCents / 100,
    }));

  const transactions = ds.movements.flatMap((m) => movementTransactions(ds, m));
  return { customers, accounts, bills, transactions };
}

function partyName(ds: Dataset, party: Party): string {
  if (party.type === 'affiliate') return ds.affiliates.find((a) => a.key === party.key)?.legalName ?? party.key;
  return ds.clients.find((c) => c.id === party.id)?.legalName ?? party.id;
}

function movementTransactions(ds: Dataset, m: BankMovement): TransactionPlan[] {
  const platformAccount = m.platformAccount;
  const legal = ds.platform.legalName;
  const base = { movementId: m.id, transaction_date: m.valueDate, amount: m.amountCents };

  if (m.kind === 'bank_fee' || !m.party) {
    return [{
      ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status,
      describe: () => formatMemo('BANK FEE', { DESC: 'INCOMING WIRE FEES', PERIOD: m.refs[0], ID: m.id }),
    }];
  }

  const party = m.party;
  const counterKey = partyAccountKey(party);
  const name = partyName(ds, party);
  const counterStatus = m.counterpartyStatus ?? m.status;

  if (m.kind === 'ach_return') {
    const fields = (acct: (k: AccountKey) => string) => ({ ORIG: name, ORIG_ACCT: acct(counterKey), REF: m.refs, ID: m.id, ORIG_ID: m.reverses });
    return [
      { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status,
        describe: (acct) => formatMemo('ACH RETURN R01 NSF', fields(acct)) },
      { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'deposit', status: counterStatus,
        describe: (acct) => formatMemo('ACH RETURN R01 NSF', { BENE: legal, BENE_ACCT: acct(platformAccount), REF: m.refs, ID: m.id, ORIG_ID: m.reverses }) },
    ];
  }

  if (m.direction === 'in') {
    return [
      { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'deposit', status: m.status,
        describe: (acct) => formatMemo(`${m.rail} IN`, { ORIG: m.memoName ?? name, ORIG_ACCT: acct(counterKey), REF: m.refs, ID: m.id }) },
      { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'withdrawal', status: counterStatus,
        describe: (acct) => formatMemo(`${m.rail} OUT`, { BENE: legal, BENE_ACCT: acct(platformAccount), REF: m.refs, ID: m.id }) },
    ];
  }

  return [
    { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status,
      describe: (acct) => formatMemo(`${m.rail} OUT`, { BENE: name, BENE_ACCT: acct(counterKey), REF: m.refs, ID: m.id }) },
    { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'deposit', status: counterStatus,
      describe: (acct) => formatMemo(`${m.rail} IN`, { ORIG: legal, ORIG_ACCT: acct(platformAccount), REF: m.refs, ID: m.id }) },
  ];
}
