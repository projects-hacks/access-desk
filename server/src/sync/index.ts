import { Timestamp } from 'spacetimedb';
import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { env } from '../lib/env';
import { bankRecords } from './sources/bank';
import { chainRecords } from './sources/chain';
import { glRows } from './sources/gl';
import { historyRecords } from './sources/history';
import type { PlatformSimulator } from '../platform/simulator';
import { platformRecords } from './sources/platform';
import { SyncWriter, type SyncRecord } from './writer';

const LABELS: Record<string, string> = {
  crm: 'CRM',
  billing: 'Billing',
  platform_admin: 'Platform admin',
  custody: 'Custody',
  positions: 'Positions & financing',
  gl: 'General ledger',
  history: 'History (12 months)',
  bank: 'Bank feed (Nessie)',
  chain: 'On-chain wallet',
};

export interface PassResult {
  source: string;
  records: number;
  written: number;
  errors: string[];
}

/** Pulls every system of record into SpacetimeDB. One instance per database. */
export class Sync {
  private writer: SyncWriter;
  private ledgerHashes = new Map<string, string>();
  private running = Promise.resolve();

  constructor(
    private readonly conn: DbConnection,
    private readonly bank: Bank,
    private readonly ds: Dataset,
    private readonly platform: PlatformSimulator,
    private readonly log: (msg: string) => void = console.log,
  ) {
    this.writer = new SyncWriter(conn);
  }

  /** Subscribes to the rows sync needs to read (the clock). Call once before passes. */
  ready(): Promise<void> {
    return new Promise((resolve) => {
      this.conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.clock, tables.platform, tables.cashMovement]);
    });
  }

  simDate(): string {
    const clock = this.conn.db.clock.id.find(1);
    if (!clock) throw new Error('clock row missing: is the module published?');
    return clock.simDate;
  }

  /** Full pass: platform systems, then bank and chain. Serialized so passes never overlap. */
  full(): Promise<PassResult[]> {
    return this.serialize(async () => {
      await this.syncPlatformRow();
      const results: PassResult[] = [];
      for (const [source, records] of Object.entries(platformRecords(this.conn, this.ds, this.bank.map, this.platform))) {
        results.push(await this.runSource(source, records));
      }
      // The ledger before cash: payment checking asks it whether treasury already booked a receipt.
      results.push(await this.syncLedger());
      // After billing (it claims billing-applied cash), before live cash.
      results.push(await this.runSource('history', historyRecords(this.conn, this.ds, this.bank.map)));
      results.push(...(await this.cashOnly()));
      await this.conn.reducers.tieOut({ trigger: 'full sync' });
      return results;
    });
  }

  /** Bank and chain only: what changes during the demo. */
  cash(): Promise<PassResult[]> {
    return this.serialize(async () => {
      const results = await this.cashOnly();
      if (results.some((r) => r.written)) await this.conn.reducers.tieOut({ trigger: 'new bank activity' });
      return results;
    });
  }

  start(): () => void {
    const tick = (fn: () => Promise<PassResult[]>) => () =>
      fn().then(
        (results) => results.filter((r) => r.written || r.errors.length).forEach((r) => this.report(r)),
        (err) => this.log(`[sync] ${err instanceof Error ? err.message : String(err)}`),
      );
    void tick(() => this.full())();
    const cash = setInterval(tick(() => this.cash()), 5_000);
    const platform = setInterval(tick(() => this.full()), 60_000);
    return () => {
      clearInterval(cash);
      clearInterval(platform);
    };
  }

  report(r: PassResult) {
    this.log(`[sync:${r.source}] ${r.written}/${r.records} written${r.errors.length ? `, ${r.errors.length} errors: ${r.errors.slice(0, 3).join('; ')}` : ''}`);
  }

  private async cashOnly(): Promise<PassResult[]> {
    const simDate = this.simDate();
    const results: PassResult[] = [];
    for (const [source, records] of [
      ['bank', await bankRecords(this.conn, this.bank, simDate)],
      ['chain', chainRecords(this.conn, this.ds, simDate)],
    ] as const) {
      // Live cash goes in date order, one at a time: which of two identical wires is the duplicate must not depend on timing.
      records.sort((a, b) => a.row.valueOn.localeCompare(b.row.valueOn) || a.row.bankRef.localeCompare(b.row.bankRef));
      const result = await this.runSource(source, records, 1);
      result.errors.push(...(await this.removeStale(source === 'bank' ? 'nessie' : 'chain', new Set(records.map((r) => r.id)))));
      results.push(result);
    }
    return results;
  }

  /** Deletes cash rows the source no longer shows, so the database never holds stale movements. */
  private async removeStale(origin: string, current: Set<string>): Promise<string[]> {
    const errors: string[] = [];
    for (const m of this.conn.db.cashMovement.iter()) {
      if (m.source !== origin || current.has(m.id)) continue;
      try {
        await this.conn.reducers.removeCashMovement({ id: m.id });
        this.writer.forget('cash_movement', m.id);
        this.log(`[sync:${origin}] removed ${m.bankRef} (no longer in source)`);
      } catch (err) {
        errors.push(`remove ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errors;
  }

  private async runSource<Row>(source: string, records: SyncRecord<Row>[], concurrency?: number): Promise<PassResult> {
    const { written, errors } = await this.writer.write(source, records, concurrency);
    await this.conn.reducers.setSyncStatus({
      row: {
        source,
        label: LABELS[source] ?? source,
        status: errors.length ? 'error' : 'synced',
        recordCount: records.length,
        cursor: new Date().toISOString(),
        lastSyncAt: Timestamp.now(),
        error: errors.length ? errors.slice(0, 3).join('; ') : undefined,
      },
    });
    return { source, records: records.length, written, errors };
  }

  /** Ledger lines in batches; unchanged lines are skipped. */
  private async syncLedger(): Promise<PassResult> {
    const rows = glRows(this.platform);
    const changed = rows.filter((r) => this.ledgerHashes.get(r.id) !== ledgerHash(r));
    const errors: string[] = [];
    for (let i = 0; i < changed.length; i += 250) {
      const batch = changed.slice(i, i + 250);
      try {
        await this.conn.reducers.upsertLedgerEntries({ rows: batch });
        for (const r of batch) this.ledgerHashes.set(r.id, ledgerHash(r));
      } catch (err) {
        errors.push(`ledger batch ${i / 250}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.conn.reducers.setSyncStatus({
      row: {
        source: 'gl', label: LABELS.gl!, status: errors.length ? 'error' : 'synced', recordCount: rows.length,
        cursor: new Date().toISOString(), lastSyncAt: Timestamp.now(), error: errors.length ? errors.join('; ') : undefined,
      },
    });
    return { source: 'gl', records: rows.length, written: errors.length ? 0 : changed.length, errors };
  }

  private async syncPlatformRow() {
    const collections = this.bank.map.accounts.collections;
    if (!collections) throw new Error('collections account missing from seed map');
    await this.conn.reducers.setPlatform({
      name: env.PLATFORM_NAME,
      legalName: env.PLATFORM_LEGAL_NAME,
      wireInstructions: `${env.PLATFORM_LEGAL_NAME} · ACCT ${collections.number} · reference your client id`,
      autoApplyLimitCents: 5_000_000n,
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.running.then(fn, fn);
    this.running = next.then(() => undefined, () => undefined);
    return next;
  }
}

const ledgerHash = (r: { journalId: string; accountCode: string; debitCents: bigint; creditCents: bigint; postedOn: string }) =>
  `${r.journalId}|${r.accountCode}|${r.debitCents}|${r.creditCents}|${r.postedOn}`;
