import { createHash } from 'node:crypto';
import { Timestamp } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';

const jsonSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export interface SyncRecord<Row> {
  /** Golden table name, e.g. `invoice`. */
  table: string;
  /** Primary key of the golden row. */
  id: string;
  row: Row;
  /** What the source returned, kept for lineage. Defaults to the row. */
  payload?: unknown;
  /** Raw record id; defaults to `<source>:<table>:<id>`. */
  rawId?: string;
  upsert: (row: Row) => Promise<void>;
}

/**
 * Writes golden rows plus their raw record, skipping anything unchanged
 * since the last pass. Errors are collected, never swallowed.
 */
export class SyncWriter {
  private hashes = new Map<string, string>();

  constructor(private readonly conn: DbConnection) {}

  async write<Row>(source: string, records: SyncRecord<Row>[], concurrency = 25): Promise<{ written: number; errors: string[] }> {
    const errors: string[] = [];
    let written = 0;
    const queue = [...records];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const payloadJson = JSON.stringify(r.payload ?? r.row, jsonSafe);
        const hash = createHash('sha256').update(JSON.stringify(r.row, jsonSafe)).digest('hex');
        const key = `${r.table}:${r.id}`;
        if (this.hashes.get(key) === hash) continue;
        try {
          const now = Timestamp.now();
          await this.conn.reducers.upsertRawRecord({
            row: {
              id: r.rawId ?? `${source}:${r.table}:${r.id}`, source, hash, payloadJson,
              firstSeenAt: now, lastSeenAt: now, goldenTable: r.table, goldenId: r.id,
            },
          });
          await r.upsert(r.row);
          this.hashes.set(key, hash);
          written++;
        } catch (err) {
          errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { written, errors };
  }

  forget(table: string, id: string) {
    this.hashes.delete(`${table}:${id}`);
  }

  /** Forget what was sent, so the next pass re-writes everything (used after a database reset). */
  reset() {
    this.hashes.clear();
  }
}
