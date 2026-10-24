import { RESTRICTION_LADDER, type Product } from '../domain';
import { addDays } from './dates';
import type { Client, Dataset } from './types';

/**
 * The platform-side records for each client: contract, clauses, custody,
 * positions, access levers. Built from the dataset so the story stays consistent.
 */

export const PRICES = { BTC: 8_500_000, ETH: 320_000, USD: 100 } as const; // cents per unit on the sim date

/** Client statuses on the morning of the demo, before any agent action. */
const STATUS: Record<string, string> = {
  'ORG-90802': 'restricted',
  'ORG-90731': 'restricted',
  'ORG-90816': 'prepay',
  'ORG-90744': 'prepay',
  'ORG-90758': 'restricted',
};

const RENEWALS: Record<string, string> = {
  'ORG-90412': '2026-03-12',
  'ORG-90455': '2026-03-20',
  'ORG-90302': '2026-03-13',
  'ORG-90229': '2026-04-02',
  'ORG-90355': '2026-05-01',
};

export interface ContractRow { clientId: string; msaRef: string; termsDays: number; graceDays: number; cureDays: number; crossDefault: boolean }
export interface ClauseRow { id: string; clientId: string; clause: string; kind: string; allowed: boolean; text: string }
export interface HoldingRow { id: string; clientId: string; asset: string; quantity: number; valueCents: number }
export interface PositionRow { id: string; clientId: string; instrument: string; side: string; notionalCents: number; hedgeGroup?: string; status: string }
export interface LeverRow { id: string; clientId: string; lever: string; state: string; detail: string }
export interface CapabilityRow { id: string; product: string; lever: string; step: string; gentleness: number; reversible: boolean; twoApprovers: boolean; adapterAction: string }
export interface OwedRow { id: string; clientId: string; kind: string; amountCents: number; asOf: string }
export interface DisputeRow { id: string; invoiceId: string; clientId: string; amountCents: number; reason: string; openedOn: string; status: string; owner: string }

export function clientStatus(c: Client): string {
  return STATUS[c.id] ?? 'active';
}

export function renewalOn(c: Client): string | undefined {
  return RENEWALS[c.id];
}

export function contractFor(c: Client): ContractRow {
  const grace = [15, 10, 10, 5, 3][c.tier - 1] ?? 5;
  const cure = c.tier <= 3 ? 15 : 10;
  return { clientId: c.id, msaRef: `MSA-${c.id.slice(4)}`, termsDays: c.termsDays, graceDays: grace, cureDays: cure, crossDefault: c.tier >= 4 };
}

export function clausesFor(c: Client): ClauseRow[] {
  const row = (clause: string, kind: string, allowed: boolean, text: string): ClauseRow => ({
    id: `${c.id}:${clause}`, clientId: c.id, clause, kind, allowed, text,
  });
  // Debit from custody needs explicit consent; only these clients signed it (Bluefin is demo step 2).
  const debit = c.products.includes('CUSTODY') && (c.tier <= 2 || c.segment === 'Market maker');
  const clauses = [
    row('7.2', 'set_off', true, 'The platform may withhold from amounts payable to the client any sum due and unpaid under this Agreement.'),
    row('6.3', 'debit', debit, debit
      ? 'Fees due may be debited from the client’s custody balance after the grace period.'
      : 'Debits from custody require the client’s written consent for each debit.'),
    row('9.1', 'cure', true, 'The client has the cure period after notice to remedy a payment default before further restrictions.'),
    row('11', 'no_forced_close', true, 'The platform will not force-close client positions to recover fees.'),
  ];
  if (c.segment === 'Fintech') clauses.push(row('9.3', 'prepay', true, 'After repeated late payment the platform may require prepayment for usage-based services.'));
  if (c.segment === 'Corporate treasury') clauses.push(row('12.4', 'change_of_control', true, 'Amounts due become payable at the closing of a change of control.'));
  return clauses;
}

/** Custody sized from the monthly custody fee (~1.6 bps/month of assets). Kestrel matches the design exactly. */
export function holdingsFor(c: Client): HoldingRow[] {
  if (!c.products.includes('CUSTODY')) return [];
  const mk = (asset: keyof typeof PRICES, quantity: number): HoldingRow => ({
    id: `${c.id}:${asset}`, clientId: c.id, asset, quantity, valueCents: Math.round(quantity * PRICES[asset]),
  });
  if (c.id === 'ORG-90412') return [mk('BTC', 98.4), mk('ETH', 1210), mk('USD', 174_200)];
  const assetsUsd = (c.monthly.CUSTODY ?? 0) * 620;
  const usd = Math.round((assetsUsd * 0.08) / 100) * 100;
  // Bluefin must be able to cover its overdue fees from cash (demo step 2).
  const cash = c.id === 'ORG-90233' ? Math.max(usd, 240_000) : usd;
  const btc = Math.round(((assetsUsd * 0.6) / (PRICES.BTC / 100)) * 10) / 10;
  const eth = Math.round((assetsUsd * 0.32) / (PRICES.ETH / 100));
  return [mk('BTC', btc), mk('ETH', eth), mk('USD', cash)];
}

export function positionsFor(c: Client): PositionRow[] {
  if (!c.products.includes('TRADING')) return [];
  const mk = (n: number, instrument: string, side: string, notional: number, hedgeGroup?: string): PositionRow => ({
    id: `${c.id}:P${n}`, clientId: c.id, instrument, side, notionalCents: notional * 100, hedgeGroup, status: 'open',
  });
  if (c.id === 'ORG-90412') {
    // 3 hedged pairs, $4.82M gross, net delta ~0.
    return [
      mk(1, 'BTC-PERP', 'short', 1_210_000, 'H1'), mk(2, 'BTC', 'long', 1_210_000, 'H1'),
      mk(3, 'ETH-MAR26', 'short', 720_000, 'H2'), mk(4, 'ETH', 'long', 720_000, 'H2'),
      mk(5, 'SOL-MAR26', 'short', 480_000, 'H3'), mk(6, 'SOL', 'long', 480_000, 'H3'),
    ];
  }
  const size = Math.round(((c.monthly.TRADING ?? 0) * 18) / 1000) * 1000;
  if (c.segment === 'Market maker') {
    return [mk(1, 'BTC-PERP', 'short', size, 'H1'), mk(2, 'BTC', 'long', size, 'H1'), mk(3, 'ETH', 'long', Math.round(size / 3))];
  }
  return [mk(1, 'BTC', 'long', size), mk(2, 'ETH-PERP', 'short', Math.round(size / 2))];
}

const LEVER_PRODUCT: Record<string, Product> = { withdrawals: 'CUSTODY', trading: 'TRADING', api: 'API', financing: 'FINANCING' };

export function leversFor(c: Client): LeverRow[] {
  const status = clientStatus(c);
  return Object.entries(LEVER_PRODUCT).map(([lever, product]) => {
    const used = c.products.includes(product);
    let state = used ? 'active' : 'not_used';
    let detail = used ? 'Normal' : 'Not part of contract';
    if (lever === 'api' && used) detail = `${c.tier <= 2 ? '5,000' : '1,000'} req/s`;
    if (lever === 'withdrawals' && used) detail = 'All assets withdrawable';
    if (used && status === 'restricted' && lever === 'api') { state = 'limited'; detail = 'Read-only'; }
    if (used && status === 'restricted' && lever === 'financing') { state = 'off'; detail = 'No new borrowing'; }
    if (used && status === 'prepay' && lever === 'api') { state = 'limited'; detail = 'Prepay required'; }
    return { id: `${c.id}:${lever}`, clientId: c.id, lever, state, detail };
  });
}

/** What this platform's admin console can do, gentlest first. */
export function capabilities(): CapabilityRow[] {
  const leverOf: Record<Product, string> = { CUSTODY: 'withdrawals', TRADING: 'trading', API: 'api', FINANCING: 'financing' };
  return (Object.entries(RESTRICTION_LADDER) as [Product, readonly string[]][]).flatMap(([product, steps]) =>
    steps.map((step, i) => ({
      id: `${product}:${step}`,
      product,
      lever: leverOf[product],
      step,
      gentleness: i + 1,
      reversible: true,
      twoApprovers: step === 'FULL_FREEZE' || step === 'CLOSE_ONLY',
      adapterAction: `admin.${leverOf[product]}.${step.toLowerCase()}`,
    })),
  );
}

export function owedToClient(ds: Dataset): OwedRow[] {
  return [
    { id: 'ORG-90518:staking', clientId: 'ORG-90518', kind: 'staking_rewards', amountCents: 1_000_000, asOf: ds.simDate },
    { id: 'ORG-90355:staking', clientId: 'ORG-90355', kind: 'staking_rewards', amountCents: 382_000, asOf: ds.simDate },
    { id: 'ORG-90287:rebate', clientId: 'ORG-90287', kind: 'rebate', amountCents: 412_000, asOf: ds.simDate },
  ];
}

export function disputes(ds: Dataset): DisputeRow[] {
  return ds.invoices
    .filter((i) => i.status === 'disputed')
    .map((i) => ({
      id: `DSP-${i.id.slice(4)}`, invoiceId: i.id, clientId: i.clientId, amountCents: i.amountCents,
      reason: 'Client says overage was double-counted during the Jan 14 outage', openedOn: '2026-02-18', status: 'under_review', owner: 'Marcus Okafor',
    }));
}

export interface NoticeRow { ref: string; clientId: string; channel: string; body: string; sentOn: string }

/**
 * Default notices the platform's dunning already sent before the demo: one per
 * client in default, the day after its grace period ended. Each starts the
 * client's cure period (§9.1).
 */
export function dunningNotices(ds: Dataset): NoticeRow[] {
  const out: NoticeRow[] = [];
  for (const c of ds.clients) {
    const { graceDays, cureDays } = contractFor(c);
    const defaulted = ds.invoices
      .filter((i) => i.clientId === c.id && i.status === 'open' && i.paidCents < i.amountCents && addDays(i.dueOn, graceDays) < ds.simDate)
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    const first = defaulted[0];
    if (!first) continue;
    const sentOn = addDays(first.dueOn, graceDays + 1);
    const owed = defaulted.filter((i) => addDays(i.dueOn, graceDays) < sentOn).reduce((n, i) => n + i.amountCents - i.paidCents, 0);
    out.push({
      ref: `DUN-${c.id.slice(4)}-${sentOn}`, clientId: c.id, channel: 'email', sentOn,
      body: `Payment of $${(owed / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} is past due (${first.id}, due ${first.dueOn}). `
        + `Under §9.1 you have ${cureDays} days from this notice (until ${addDays(sentOn, cureDays)}) to pay before access may be restricted.`,
    });
  }
  return out;
}
