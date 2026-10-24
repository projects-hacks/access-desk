import { tables, type DbConnection } from '../module_bindings';
import type { GatewayCommand } from '../module_bindings/types';
import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { GatewayActionSchema, type GatewayResult } from '../platform/commands';
import { PermanentError, type PlatformApi } from '../platform/client';
import { sendRefund } from './bank';

/**
 * The gateway: the only writer to systems of record. Executes queued commands
 * strictly in id order (a receipt journal always posts before its application),
 * claims each one first so it can never run twice, and reports the system's
 * resulting state back to SpacetimeDB.
 */
export class Gateway {
  private draining = false;
  private again = false;

  constructor(
    private readonly conn: DbConnection,
    private readonly platform: PlatformApi,
    private readonly bank: Bank,
    private readonly ds: Dataset,
    /** Called after a bank write, so the movement is picked up immediately. */
    private readonly onBankWrite: () => Promise<unknown>,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  ready(): Promise<void> {
    return new Promise((resolve) => this.conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.gatewayCommand]));
  }

  start(): () => void {
    const kick = () => void this.drain();
    this.conn.db.gatewayCommand.onInsert(kick);
    this.conn.db.gatewayCommand.onUpdate(kick);
    const timer = setInterval(kick, 3_000);
    kick();
    return () => clearInterval(timer);
  }

  /** Runs every queued command, oldest first, until none are left. Resolves when idle. */
  async drain(): Promise<number> {
    if (this.draining) {
      this.again = true;
      return 0;
    }
    this.draining = true;
    let ran = 0;
    try {
      do {
        this.again = false;
        for (let next = this.nextQueued(); next; next = this.nextQueued()) {
          const ok = await this.run(next);
          ran++;
          if (!ok) break; // a retryable failure blocks later commands until it succeeds
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
    return ran;
  }

  pending(): number {
    return [...this.conn.db.gatewayCommand.iter()].filter((c) => c.status === 'queued' || c.status === 'executing').length;
  }

  private nextQueued(): GatewayCommand | undefined {
    let next: GatewayCommand | undefined;
    for (const c of this.conn.db.gatewayCommand.iter()) {
      if (c.status === 'queued' && (!next || c.id < next.id)) next = c;
    }
    return next;
  }

  /** Returns false when the command must be retried later. */
  private async run(cmd: GatewayCommand): Promise<boolean> {
    try {
      await this.conn.reducers.claimGatewayCommand({ id: cmd.id });
    } catch {
      return true; // someone else took it
    }
    try {
      const action = GatewayActionSchema.parse(JSON.parse(cmd.actionJson));
      let result: GatewayResult;
      let externalRef: string | undefined;
      if (action.type === 'REFUND') {
        const nessie = await sendRefund(this.bank, this.ds, String(cmd.id), action);
        result = { type: 'REFUND', nessie };
        externalRef = nessie.platform;
      } else {
        result = await this.platform.execute(String(cmd.id), action);
      }
      await this.conn.reducers.completeGatewayCommand({ id: cmd.id, resultJson: JSON.stringify(result), externalRef });
      if (action.type === 'REFUND') await this.onBankWrite();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentError || (err instanceof Error && err.name === 'ZodError');
      this.log(`[gateway] ${cmd.type} ${cmd.key} failed (${permanent ? 'permanent' : 'will retry'}): ${message}`);
      await this.conn.reducers.failGatewayCommand({ id: cmd.id, error: message.slice(0, 500), retryable: !permanent });
      if (!permanent) await new Promise((r) => setTimeout(r, 500 * 2 ** cmd.attempts));
      return permanent;
    }
  }
}
