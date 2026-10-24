import { audit, type Ctx } from '../context';

const jsonSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
export const toJson = (v: unknown) => JSON.stringify(v, jsonSafe);

/** GL accounts our system posts to (chart in server/src/dataset/gl.ts). */
export const GL = {
  CASH: { collections: '1010', disbursements: '1011', wallet: '1015' } as Record<string, string>,
  RECEIVABLES: '1200',
  LOANS: '1300',
  CLIENT_FUNDS: '2100',
  UNAPPLIED_CASH: '2300',
  BANK_FEES: '6850',
};

export const cashAccount = (platformAccount: string) => GL.CASH[platformAccount] ?? GL.CASH.collections!;

export interface JournalLine {
  account: string;
  debitCents: bigint;
  creditCents: bigint;
}

export const dr = (account: string, cents: bigint): JournalLine => ({ account, debitCents: cents, creditCents: 0n });
export const cr = (account: string, cents: bigint): JournalLine => ({ account, debitCents: 0n, creditCents: cents });

/**
 * Queue an action for the gateway. Idempotent by `key`: if a live (queued,
 * executing or done) command with the same key exists, nothing is added.
 */
export function queueCommand(ctx: Ctx, key: string, action: { type: string } & Record<string, unknown>, workItemId?: bigint) {
  for (const c of ctx.db.gatewayCommand.key.filter(key)) {
    if (c.status !== 'failed') return c;
  }
  const cmd = ctx.db.gatewayCommand.insert({
    id: 0n, key, type: action.type, workItemId, actionJson: toJson(action), status: 'queued',
    resultJson: undefined, externalRef: undefined, attempts: 0, error: undefined,
    createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
  });
  audit(ctx, { action: 'COMMAND_QUEUED', subjectType: 'gateway_command', subjectId: String(cmd.id), workItemId, toState: 'queued', detail: `${action.type} ${key}` });
  return cmd;
}

/** True when the ledger (or a queued journal) already covers this source document. */
export function isBooked(ctx: Ctx, ref: string, journalId?: string): boolean {
  if ([...ctx.db.ledgerEntry.ref.filter(ref)].length > 0 && !journalId) return true;
  if (journalId && [...ctx.db.ledgerEntry.journalId.filter(journalId)].length > 0) return true;
  if (journalId) for (const c of ctx.db.gatewayCommand.key.filter(journalId)) if (c.status !== 'failed') return true;
  return false;
}

/** Queue a balanced journal for the GL. Throws on an unbalanced journal: a bug, never silently posted. */
export function queueJournal(ctx: Ctx, journalId: string, postedOn: string, ref: string, memo: string, lines: JournalLine[], workItemId?: bigint) {
  const nonZero = lines.filter((l) => l.debitCents > 0n || l.creditCents > 0n);
  const debits = nonZero.reduce((s, l) => s + l.debitCents, 0n);
  const credits = nonZero.reduce((s, l) => s + l.creditCents, 0n);
  if (debits !== credits || debits === 0n) throw new Error(`journal ${journalId} does not balance (${debits} / ${credits})`);
  if (isBooked(ctx, ref, journalId)) return;
  queueCommand(ctx, journalId, { type: 'POST_JOURNAL', journal: { journalId, postedOn, ref, memo, lines: nonZero } }, workItemId);
}
