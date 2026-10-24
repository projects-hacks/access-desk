import type { Address } from './client';
import { achCollection, achReturn, analysisFee, invoiceRemittance, wireIn, wireOut, type RemittanceStyle } from '../bank-text/format';
import type { BankMovement, Client, Dataset, Party } from '../../dataset';

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

function partyBank(ds: Dataset, party: Party): Client['bank'] {
  const bank = party.type === 'affiliate'
    ? ds.affiliates.find((a) => a.key === party.key)?.bank
    : ds.clients.find((c) => c.id === party.id)?.bank;
  if (!bank) throw new Error(`no bank for ${JSON.stringify(party)}`);
  return bank;
}

/** The platform's own bank (receiving bank on incoming wires). */
export const PLATFORM_BANK = { name: 'JPMORGAN CHASE BANK NA', id: '021000021' };

const STYLES: RemittanceStyle[] = ['spaced', 'slashed', 'words', 'range'];
function styleFor(clientId: string): RemittanceStyle {
  let h = 0;
  for (const ch of clientId) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return STYLES[h % STYLES.length]!;
}

/** Payers that habitually mistype digits (letters for digits). */
const TYPO_CLIENTS = new Set(['ORG-90142']);

/** What the payer wrote in the remittance field. */
function remittanceFor(ds: Dataset, m: BankMovement): string {
  if (m.remittanceText) return m.remittanceText;
  const party = m.party;
  const clientId = party?.type === 'client' ? party.id : party ? ds.affiliates.find((a) => a.key === party.key)?.parentId : undefined;
  const invoices = m.refs.filter((r) => r.startsWith('INV-'));
  const loan = m.refs.find((r) => r.startsWith('LN-'));
  const org = m.refs.find((r) => r.startsWith('ORG-'));
  if (loan) return `${loan} ${m.direction === 'out' ? 'DRAWDOWN' : 'PRINCIPAL REPAYMENT'}`;
  if (org && m.caseId === 'lump-sum') return `${org.replace('-', '')} CATCH UP DEC JAN`;
  if (org) return `REF ${org} PER WIRE INSTRUCTIONS`;
  if (!invoices.length) return '';
  const international = party && partyBank(ds, party).country !== 'US';
  let text = invoiceRemittance(invoices, international ? 'swift' : styleFor(clientId ?? ''), international ? '/RFB/JAN26' : '');
  // A keying slip in the first invoice number: letter I for 1 (or O for 0).
  if (clientId && TYPO_CLIENTS.has(clientId)) text = /\d*1\d*/.test(text) ? text.replace(/(\d*?)1/, '$1I') : text.replace(/(\d)0/, '$1O');
  return text;
}

function movementTransactions(ds: Dataset, m: BankMovement): TransactionPlan[] {
  const platformAccount = m.platformAccount;
  const legal = ds.platform.legalName;
  const base = { movementId: m.id, transaction_date: m.valueDate, amount: m.amountCents };

  if (m.kind === 'bank_fee' || !m.party) {
    return [{
      ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status,
      describe: () => analysisFee({ trn: m.id, period: m.refs[0] ?? '', wires: Math.round(m.amountCents / 1500), perWireCents: 1500 }),
    }];
  }

  const party = m.party;
  const counterKey = partyAccountKey(party);
  const name = m.memoName ?? partyName(ds, party);
  const bank = partyBank(ds, party);
  const counterStatus = m.counterpartyStatus ?? m.status;
  const remittance = remittanceFor(ds, m);
  const clientId = party.type === 'client' ? party.id : ds.affiliates.find((a) => a.key === party.key)?.parentId ?? '';

  if (m.kind === 'ach_return') {
    const returned = (acct: (k: AccountKey) => string) =>
      achReturn({ trace: m.id, originalTrace: m.reverses ?? '', code: 'R01', reason: 'Insufficient funds', company: name, account: acct(counterKey) });
    return [
      { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status, describe: returned },
      { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'deposit', status: counterStatus,
        describe: () => `ACH RETURN R01 CREDIT ${legal.toUpperCase()} TRACE:${m.id} ORIG TRACE:${m.reverses ?? ''}` },
    ];
  }

  if (m.direction === 'in' && m.rail === 'ACH') {
    // We pulled this payment from the client's account (auto-debit).
    return [
      { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'deposit', status: m.status,
        describe: (acct) => achCollection({ trace: m.id, company: name, account: acct(counterKey), individualId: clientId.replace('-', ''), addenda: `${remittance} JAN API USAGE` }) },
      { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'withdrawal', status: counterStatus,
        describe: () => `ACH DEBIT ${legal.toUpperCase()} CCD TRACE:${m.id} ADDENDA:${remittance}` },
    ];
  }

  if (m.direction === 'in') {
    const international = bank.country !== 'US';
    const affiliateFeeder = party.type === 'affiliate' && international;
    return [
      { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'deposit', status: m.status,
        describe: (acct) => wireIn({
          trn: m.id, date: m.valueDate, orig: name, origAccount: acct(counterKey), bank, remittance,
          international: international ? {
            uetr: uetrFor(m.id),
            instructedCents: m.instructedCents ?? m.amountCents,
            chargeBearer: m.chargeBearer ?? (affiliateFeeder ? 'OUR' : 'SHA'),
            chargesCents: m.chargesCents ?? 0,
          } : undefined,
        }) },
      { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'withdrawal', status: counterStatus,
        describe: (acct) => wireOut({ trn: m.id, date: m.valueDate, beneficiary: legal, account: acct(platformAccount), bank: PLATFORM_BANK, remittance }) },
    ];
  }

  return [
    { ...base, key: `${m.id}:platform`, side: 'platform', accountKey: platformAccount, type: 'withdrawal', status: m.status,
      describe: (acct) => wireOut({ trn: m.id, date: m.valueDate, beneficiary: name, account: acct(counterKey), bank, remittance }) },
    { ...base, key: `${m.id}:counterparty`, side: 'counterparty', accountKey: counterKey, type: 'deposit', status: counterStatus,
      describe: (acct) => wireIn({ trn: m.id, date: m.valueDate, orig: legal, origAccount: acct(platformAccount), bank: PLATFORM_BANK, remittance }) },
  ];
}

/** Stable UETR (SWIFT's end-to-end id) per movement. */
function uetrFor(id: string): string {
  let h = 2166136261;
  const hex: string[] = [];
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (id.charCodeAt(i % id.length) + i), 16777619);
    hex.push(((h >>> 0) % 16).toString(16));
  }
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}
