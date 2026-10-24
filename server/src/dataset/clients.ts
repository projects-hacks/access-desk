import type { Affiliate, Client } from './types';

/**
 * The 30 clients of the demo platform. January invoices are issued Feb 1 and
 * the simulated "today" is Tue Mar 3, 2026, so `termsDays` sets days past due.
 *
 * Every `jan` behavior below is a deliberate part of the demo story; see
 * scenario.ts for the expected outcome of each planted case.
 */
const RAW: (Omit<Client, 'bank'> & { bank?: Client['bank'] })[] = [
  // ── Chronic late payers (restricted or on prepay) ─────────────────────────
  {
    id: 'ORG-90802', name: 'Vantage Loop', legalName: 'Vantage Loop Inc', segment: 'Fintech', tier: 5,
    products: ['API', 'FINANCING'], termsDays: 15, relationshipManager: 'Jonah Feld',
    monthly: { API: 21000, FINANCING: 4200 }, jan: { kind: 'open' }, olderOpenPeriods: ['2025-11', '2025-12'],
    city: 'Austin', state: 'TX',
  },
  {
    id: 'ORG-90816', name: 'Tessellate Pay', legalName: 'Tessellate Pay Inc', segment: 'Fintech', tier: 5,
    products: ['API'], termsDays: 10, relationshipManager: 'Jonah Feld',
    monthly: { API: 19000 }, jan: { kind: 'open' }, olderOpenPeriods: ['2025-12'],
    city: 'San Francisco', state: 'CA',
  },
  {
    id: 'ORG-90744', name: 'Wrenfield Digital', legalName: 'Wrenfield Digital Inc', segment: 'Fintech', tier: 4,
    products: ['API'], termsDays: 10, relationshipManager: 'Jonah Feld',
    monthly: { API: 12900 }, janOverride: { API: 12900 },
    jan: { kind: 'partial', invoiceProduct: 'API', fraction: 0.5, valueDate: '2026-02-20' },
    city: 'Denver', state: 'CO',
  },
  {
    id: 'ORG-90758', name: 'Monarch Rails', legalName: 'Monarch Rails Inc', segment: 'Fintech', tier: 4,
    products: ['CUSTODY', 'API'], termsDays: 15, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 9800, API: 13700 }, jan: { kind: 'open' }, olderOpenPeriods: ['2025-12'],
    city: 'Chicago', state: 'IL',
  },
  {
    id: 'ORG-90731', name: 'Lantern Payments', legalName: 'Lantern Payments Inc', segment: 'Fintech', tier: 3,
    products: ['API'], termsDays: 15, relationshipManager: 'Marcus Okafor',
    monthly: { API: 9460 }, jan: { kind: 'open' }, olderOpenPeriods: ['2025-12'],
    city: 'Atlanta', state: 'GA',
  },

  // ── Overdue now: the morning's decisions ──────────────────────────────────
  {
    id: 'ORG-90455', name: 'Ember Street Capital', legalName: 'Ember Street Capital LP', segment: 'Hedge fund', tier: 4,
    products: ['CUSTODY', 'TRADING'], termsDays: 7, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 11400, TRADING: 41500 }, janOverride: { CUSTODY: 11400, TRADING: 41500 },
    jan: { kind: 'open' }, city: 'Greenwich', state: 'CT',
  },
  {
    // Demo steps 3–6: hold proposed, revised, then released by the Zephyr wire.
    id: 'ORG-90412', name: 'Kestrel Quant', legalName: 'Kestrel Quant LP', segment: 'Hedge fund', tier: 3,
    products: ['CUSTODY', 'TRADING', 'API'], termsDays: 7, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 20000, TRADING: 92000, API: 30500 },
    janOverride: { CUSTODY: 20000, TRADING: 96400, API: 31800 },
    extraJanInvoices: [{ product: 'API', label: 'API overage', amount: 18400, disputed: true }],
    jan: { kind: 'demo_affiliate_wire', affiliate: 'zephyr', wireId: 'WI-5531', valueDate: '2026-03-10' },
    city: 'New York', state: 'NY',
  },
  {
    id: 'ORG-90463', name: 'Ivory Lane Capital', legalName: 'Ivory Lane Capital LP', segment: 'Hedge fund', tier: 3,
    products: ['CUSTODY', 'TRADING', 'API'], termsDays: 10, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 4200, TRADING: 8600, API: 2800 }, janOverride: { CUSTODY: 4200, TRADING: 8600, API: 2800 },
    jan: { kind: 'in_transit', valueDate: '2026-03-02' }, city: 'Boston', state: 'MA',
  },
  {
    id: 'ORG-90518', name: 'Orchard Treasury', legalName: 'Orchard Treasury Inc', segment: 'Corporate treasury', tier: 3,
    products: ['CUSTODY', 'API'], termsDays: 15, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 16000, API: 8000 }, janOverride: { CUSTODY: 16000, API: 8000 },
    // Serial disputer: disputed January the day after its default notice (history: every invoice, all upheld).
    jan: { kind: 'open' }, janDispute: { openedOn: '2026-02-28', reason: 'Custody fee charged on assets moved out in January' },
    city: 'Seattle', state: 'WA',
  },
  {
    id: 'ORG-90677', name: 'Juniper Labs', legalName: 'Juniper Labs Inc', segment: 'Fintech', tier: 4,
    products: ['CUSTODY', 'API'], termsDays: 10, relationshipManager: 'Jonah Feld',
    monthly: { CUSTODY: 6250, API: 25500 }, janOverride: { CUSTODY: 6250, API: 25500 },
    jan: { kind: 'open' }, city: 'Austin', state: 'TX',
  },
  {
    id: 'ORG-90612', name: 'Saltmarsh Ventures', legalName: 'Saltmarsh Ventures LP', segment: 'Hedge fund', tier: 4,
    products: ['CUSTODY', 'TRADING'], termsDays: 10, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 3200, TRADING: 8000 }, janOverride: { CUSTODY: 3200, TRADING: 8000 },
    jan: { kind: 'paid_not_applied', valueDate: '2026-02-19' }, city: 'Charleston', state: 'SC',
  },
  {
    // Demo step 7: novel case (client being acquired).
    id: 'ORG-90355', name: 'Cobalt Ridge Treasury', legalName: 'Cobalt Ridge Treasury Inc', segment: 'Corporate treasury', tier: 3,
    products: ['CUSTODY', 'API'], termsDays: 15, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 38200, API: 23200 }, janOverride: { CUSTODY: 38200, API: 23200 },
    jan: { kind: 'open' }, city: 'Minneapolis', state: 'MN',
  },
  {
    // Demo step 2: fees collected from custody balance, no restriction.
    id: 'ORG-90233', name: 'Bluefin Arbitrage', legalName: 'Bluefin Arbitrage LP', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING'], termsDays: 20, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 22400, TRADING: 64000 }, janOverride: { CUSTODY: 22400, TRADING: 64000 },
    jan: { kind: 'open' }, city: 'Chicago', state: 'IL',
  },
  {
    id: 'ORG-90391', name: 'Granite Bay Holdings', legalName: 'Granite Bay Holdings Inc', segment: 'Corporate treasury', tier: 3,
    products: ['CUSTODY', 'API'], termsDays: 25, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 32400, API: 25600 }, janOverride: { CUSTODY: 32400, API: 25600 },
    jan: { kind: 'duplicate_wire', daysFromDue: -7, duplicateAfterDays: 1 }, city: 'San Diego', state: 'CA',
  },
  {
    id: 'ORG-90287', name: 'Tidewater Asset Mgmt', legalName: 'Tidewater Asset Management LLC', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING', 'API'], termsDays: 25, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 14180.5, TRADING: 22000, API: 6000 }, janOverride: { CUSTODY: 14180.5, TRADING: 22000, API: 6000 },
    jan: { kind: 'open' }, city: 'Stamford', state: 'CT',
  },
  {
    id: 'ORG-90689', name: 'Quillon Systems', legalName: 'Quillon Systems Inc', segment: 'Fintech', tier: 3,
    products: ['API'], termsDays: 25, relationshipManager: 'Jonah Feld',
    monthly: { API: 7840 }, janOverride: { API: 7840 },
    jan: { kind: 'ach_returned', paidOn: '2026-02-24', returnedOn: '2026-02-26' }, city: 'Raleigh', state: 'NC',
  },
  {
    id: 'ORG-90399', name: 'Larkspur Treasury', legalName: 'Larkspur Treasury Inc', segment: 'Corporate treasury', tier: 3,
    products: ['CUSTODY', 'API'], termsDays: 30, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 2600, API: 1500 }, jan: { kind: 'open' }, city: 'Portland', state: 'OR',
  },

  // ── In good standing ──────────────────────────────────────────────────────
  {
    id: 'ORG-90101', name: 'Halcyon Capital', legalName: 'Halcyon Capital LLC', segment: 'Market maker', tier: 1, strategic: true,
    products: ['CUSTODY', 'TRADING', 'FINANCING', 'API'], termsDays: 30, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 68000, TRADING: 342000, FINANCING: 41000, API: 36000 },
    jan: { kind: 'paid', daysFromDue: -3 }, city: 'New York', state: 'NY',
  },
  {
    id: 'ORG-90142', name: 'Meridian Flow Partners', legalName: 'Meridian Flow Partners LLC', segment: 'Market maker', tier: 2,
    products: ['CUSTODY', 'TRADING', 'FINANCING'], termsDays: 30, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 41000, TRADING: 228000, FINANCING: 22000 },
    jan: { kind: 'paid', daysFromDue: 0 }, city: 'Chicago', state: 'IL',
  },
  {
    id: 'ORG-90118', name: 'Aster Point Capital', legalName: 'Aster Point Capital LP', segment: 'Hedge fund', tier: 1,
    products: ['CUSTODY', 'TRADING', 'FINANCING'], termsDays: 30, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 52000, TRADING: 118000, FINANCING: 30500 },
    jan: { kind: 'paid', daysFromDue: -2 }, city: 'Greenwich', state: 'CT',
  },
  {
    id: 'ORG-90164', name: 'Silverline Markets', legalName: 'Silverline Markets LLC', segment: 'Market maker', tier: 2,
    products: ['CUSTODY', 'TRADING', 'API'], termsDays: 20, relationshipManager: 'Jonah Feld',
    monthly: { CUSTODY: 26000, TRADING: 151000, API: 19800 },
    jan: { kind: 'paid_onchain', valueDate: '2026-03-02', wallet: '0x91c3b07de15f2a8c64e0d9a7b3f1c2e8d5a4f4ae' },
    city: 'Miami', state: 'FL',
  },
  {
    id: 'ORG-90302', name: 'Polaris Yield Fund', legalName: 'Polaris Yield Fund LP', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING', 'FINANCING'], termsDays: 20, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 24000, TRADING: 71000, FINANCING: 15500 },
    jan: { kind: 'paid', daysFromDue: -1 }, city: 'Boston', state: 'MA',
  },
  {
    id: 'ORG-90176', name: 'Northfold Trading', legalName: 'Northfold Trading LLC', segment: 'Market maker', tier: 3,
    products: ['CUSTODY', 'TRADING'], termsDays: 20, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 12500, TRADING: 96000 }, jan: { kind: 'overpaid', extraCents: 100_000, daysFromDue: 9 },
    city: 'Jersey City', state: 'NJ',
  },
  {
    id: 'ORG-90366', name: 'Copperline Treasury', legalName: 'Copperline Treasury Inc', segment: 'Corporate treasury', tier: 2,
    products: ['CUSTODY'], termsDays: 30, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 18750 }, janOverride: { CUSTODY: 18750 },
    jan: { kind: 'no_reference', memoName: 'COPPERLINE TRSY', valueDate: '2026-03-02' }, city: 'Pittsburgh', state: 'PA',
  },
  {
    id: 'ORG-90229', name: 'Fieldstone Quant', legalName: 'Fieldstone Quant LP', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING', 'API'], termsDays: 20, relationshipManager: 'Jonah Feld',
    monthly: { CUSTODY: 15500, TRADING: 54000, API: 11200 }, olderOpenPeriods: ['2025-12'],
    jan: { kind: 'lump_sum_no_invoice_refs', valueDate: '2026-03-02' }, city: 'San Francisco', state: 'CA',
  },
  {
    id: 'ORG-90378', name: 'Harbor & Pine Treasury', legalName: 'Harbor and Pine Treasury Inc', segment: 'Corporate treasury', tier: 3,
    products: ['CUSTODY'], termsDays: 30, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 9400 }, jan: { kind: 'new_bank_account', daysFromDue: 0 }, city: 'Portland', state: 'ME',
  },
  {
    id: 'ORG-90107', name: 'Redwing Liquidity', legalName: 'Redwing Liquidity LLC', segment: 'Market maker', tier: 1, strategic: true,
    products: ['CUSTODY', 'TRADING', 'FINANCING', 'API'], termsDays: 30, relationshipManager: 'Marcus Okafor',
    monthly: { CUSTODY: 74000, TRADING: 389000, FINANCING: 52000, API: 41000 },
    jan: { kind: 'paid', daysFromDue: -4 }, city: 'Chicago', state: 'IL',
  },
  {
    id: 'ORG-90244', name: 'Basalt Global Macro', legalName: 'Basalt Global Macro LP', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING', 'FINANCING'], termsDays: 20, relationshipManager: 'Priya Nair',
    monthly: { CUSTODY: 33000, TRADING: 87000, FINANCING: 26000 },
    jan: { kind: 'paid_by_affiliate', affiliate: 'basalt-feeder', daysFromDue: 9 }, city: 'New York', state: 'NY',
  },
  {
    id: 'ORG-90431', name: 'Ostrava Digital Assets', legalName: 'Ostrava Digital Assets LP', segment: 'Hedge fund', tier: 3,
    products: ['CUSTODY', 'TRADING'], termsDays: 15, relationshipManager: 'Jonah Feld',
    monthly: { CUSTODY: 9100, TRADING: 31000 }, janOverride: { CUSTODY: 9100, TRADING: 31420 },
    jan: { kind: 'short_paid', shortCents: 2500, valueDate: '2026-03-03' },
    city: 'Miami', state: 'FL', bank: { name: 'CESKA SPORITELNA AS', id: 'GIBACZPX', country: 'CZ' },
  },
  {
    id: 'ORG-90251', name: 'Cinder Peak Partners', legalName: 'Cinder Peak Partners LP', segment: 'Hedge fund', tier: 2,
    products: ['CUSTODY', 'TRADING'], termsDays: 20, relationshipManager: 'Sofia Lindqvist',
    monthly: { CUSTODY: 17800, TRADING: 46500 }, jan: { kind: 'wrong_reference', daysFromDue: 9 },
    city: 'Dallas', state: 'TX',
  },
];

/** US banks (public routing numbers) assigned to domestic clients. */
const US_BANKS: Client['bank'][] = [
  { name: 'JPMORGAN CHASE BANK NA', id: '021000021', country: 'US' },
  { name: 'BANK OF AMERICA NA', id: '026009593', country: 'US' },
  { name: 'CITIBANK NA', id: '021000089', country: 'US' },
  { name: 'WELLS FARGO BANK NA', id: '121000248', country: 'US' },
  { name: 'THE BANK OF NEW YORK MELLON', id: '021000018', country: 'US' },
];

export const CLIENTS: Client[] = RAW.map((c, i) => ({ ...c, bank: c.bank ?? US_BANKS[i % US_BANKS.length]! }));

/** Entities that pay on a client's behalf. Mapped to the parent in the CRM, never in the bank. */
export const AFFILIATES: Affiliate[] = [
  { key: 'zephyr', legalName: 'Zephyr Capital Mgmt LP', parentId: 'ORG-90412', relation: 'General partner', bank: { name: 'CITIBANK NA', id: '021000089', country: 'US' } },
  // Offshore feeder: international wire, charges OUR, so it arrives in full.
  { key: 'basalt-feeder', legalName: 'Basalt GM Feeder Ltd', parentId: 'ORG-90244', relation: 'Feeder fund', bank: { name: 'BUTTERFIELD BANK (CAYMAN) LTD', id: 'BNTBKYKY', country: 'KY' } },
];
