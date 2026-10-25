import type { DbConnection } from '../../module_bindings';
import type {
  AccessLever, AssetPrice, Capability, Client, Contract, ContractClause, CustodyHolding, Dispute, Invoice, Loan,
  OwedToClient, PayerIdentity, Position,
} from '../../module_bindings/types';
import type { Dataset } from '../../dataset';
import {
  capabilities, clausesFor, clientStatus, contractFor, disputes, dunningNotices, owedToClient, positionsFor, renewalOn, type DisputeRow,
} from '../../dataset/platform-data';
import type { SeedMap } from '../../integrations/nessie/seed-map';
import type { PlatformSimulator } from '../../platform/simulator';
import type { SyncRecord } from '../writer';

/**
 * The platform's systems of record (billing, CRM, admin console, custody,
 * positions). Changing state (invoices, levers, custody) is read from the live
 * platform; reference data from the dataset. Grouped by source system.
 */
/** Billing's invoice as the golden copy stores it. */
export function invoiceRow(i: PlatformSimulator['invoices'] extends Map<string, infer V> ? V : never): Invoice {
  const status = i.status === 'open' && i.paidCents > 0 ? 'partially_paid' : i.status;
  return {
    id: i.id, clientId: i.clientId, product: i.product, label: i.label, period: i.period, issuedOn: i.issuedOn,
    dueOn: i.dueOn, amountCents: BigInt(i.amountCents), sourcePaidCents: BigInt(i.paidCents), paidCents: BigInt(i.paidCents),
    paidOn: i.paidOn, status,
  };
}

export function disputeRow(d: DisputeRow): Dispute {
  return { ...d, amountCents: BigInt(d.amountCents) };
}

export function platformRecords(conn: DbConnection, ds: Dataset, bank: SeedMap, sim: PlatformSimulator): Record<string, SyncRecord<unknown>[]> {
  const r = conn.reducers;
  const rec = <Row>(table: string, id: string, row: Row, upsert: (row: Row) => Promise<void>): SyncRecord<unknown> =>
    ({ table, id, row, upsert } as SyncRecord<unknown>);
  const accountNumber = (key: string) => {
    const acct = bank.accounts[key];
    if (!acct) throw new Error(`bank account "${key}" missing from seed map ${bank.run}`);
    return acct.number;
  };
  const loanClient = new Set(ds.loans.map((l) => l.clientId));
  const restricted = (id: string) => ds.clients.some((c) => c.id === id && clientStatus(c) === 'restricted');

  const crm: SyncRecord<unknown>[] = [];
  for (const c of ds.clients) {
    const client: Client = {
      id: c.id, name: c.name, legalName: c.legalName, segment: c.segment, tier: c.tier, strategic: c.strategic ?? false,
      relationshipManager: c.relationshipManager, renewalOn: renewalOn(c), status: clientStatus(c),
    };
    crm.push(rec('client', c.id, client, (row) => r.upsertClient({ row })));

    const identities: PayerIdentity[] = [
      { id: `${c.id}:name`, clientId: c.id, kind: 'name_alias', value: c.legalName, label: c.legalName, relation: 'self', verified: true },
      { id: `${c.id}:acct`, clientId: c.id, kind: 'bank_account', value: accountNumber(c.id), label: `${c.name} · Operating`, relation: 'self', verified: true },
    ];
    // Known wallets: only clients that pay on-chain (Silverline). Unknown wallets stay unknown on purpose.
    for (const p of ds.onchain.filter((x) => x.clientId === c.id)) {
      identities.push({ id: `${c.id}:wallet`, clientId: c.id, kind: 'wallet', value: p.wallet, label: `${c.name} · USDC wallet`, relation: 'self', verified: true });
    }
    for (const id of identities) crm.push(rec('payer_identity', id.id, id, (row) => r.upsertPayerIdentity({ row })));

    const contract: Contract = contractFor(c);
    crm.push(rec('contract', c.id, contract, (row) => r.upsertContract({ row })));
    for (const cl of clausesFor(c)) {
      const clause: ContractClause = cl;
      crm.push(rec('contract_clause', cl.id, clause, (row) => r.upsertContractClause({ row })));
    }
  }
  // Affiliates pay on a client's behalf; the CRM links their name and account to the parent.
  for (const a of ds.affiliates) {
    const ids: PayerIdentity[] = [
      { id: `aff:${a.key}:name`, clientId: a.parentId, kind: 'affiliate', value: a.legalName, label: a.legalName, relation: a.relation, verified: true },
      { id: `aff:${a.key}:acct`, clientId: a.parentId, kind: 'bank_account', value: accountNumber(`aff:${a.key}`), label: `${a.legalName} · Operating`, relation: a.relation, verified: true },
    ];
    for (const id of ids) crm.push(rec('payer_identity', id.id, id, (row) => r.upsertPayerIdentity({ row })));
  }

  const billing: SyncRecord<unknown>[] = [];
  for (const i of sim.invoices.values()) {
    billing.push(rec('invoice', i.id, invoiceRow(i), (row) => r.upsertInvoice({ row })));
  }
  // The platform's disputes (live ones, ruled on or not) win over the dataset's baseline copy of the same id.
  for (const d of [...disputes(ds).filter((x) => !sim.disputes.has(x.id)), ...sim.disputes.values()]) {
    billing.push(rec('dispute', d.id, disputeRow(d), (row) => r.upsertDispute({ row })));
  }

  const admin: SyncRecord<unknown>[] = [];
  for (const cap of capabilities()) {
    const row: Capability = cap;
    admin.push(rec('capability', cap.id, row, (x) => r.upsertCapability({ row: x })));
  }
  for (const l of sim.levers.values()) {
    {
      const row: AccessLever = { ...l, workItemId: undefined };
      admin.push(rec('access_lever', l.id, row, (x) => r.upsertAccessLever({ row: x })));
    }
  }

  const custody: SyncRecord<unknown>[] = [];
  for (const [asset, { cents, asOf }] of sim.prices) {
    const row: AssetPrice = { asset, priceCents: BigInt(cents), asOf: asOf ?? ds.simDate };
    custody.push(rec('asset_price', asset, row, (x) => r.upsertAssetPrice({ row: x })));
  }
  for (const h of sim.holdings.values()) {
    {
      const row: CustodyHolding = { ...h, valueCents: BigInt(h.valueCents) };
      custody.push(rec('custody_holding', h.id, row, (x) => r.upsertCustodyHolding({ row: x })));
    }
  }
  for (const o of owedToClient(ds)) {
    const row: OwedToClient = { ...o, amountCents: BigInt(o.amountCents) };
    custody.push(rec('owed_to_client', o.id, row, (x) => r.upsertOwedToClient({ row: x })));
  }

  const positions: SyncRecord<unknown>[] = [];
  for (const c of ds.clients) {
    for (const p of positionsFor(c)) {
      const row: Position = { ...p, notionalCents: BigInt(p.notionalCents), hedgeGroup: p.hedgeGroup };
      positions.push(rec('position', p.id, row, (x) => r.upsertPosition({ row: x })));
    }
  }
  for (const l of ds.loans) {
    if (!loanClient.has(l.clientId)) continue;
    const row: Loan = {
      id: l.id, clientId: l.clientId, lineCents: BigInt(l.lineCents), outstandingCents: BigInt(l.outstandingCents),
      status: 'active', borrowingAllowed: !restricted(l.clientId),
    };
    positions.push(rec('loan', l.id, row, (x) => r.upsertLoan({ row: x })));
  }

  // After billing and contracts: a default notice needs both to start its cure period.
  const messaging: SyncRecord<unknown>[] = [];
  for (const n of dunningNotices(ds)) messaging.push(rec('notice', n.ref, n, (x) => r.upsertNotice(x)));

  return { crm, billing, platform_admin: admin, custody, positions, messaging };
}
