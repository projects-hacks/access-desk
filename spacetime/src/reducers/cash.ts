import { SenderError, t } from 'spacetimedb/server';
import { BOOKS, route, step } from '../agents';
import { actorOf, addDays, audit, requireRole, simDate, type Ctx } from '../context';
import { createWorkItem, setMatchStatus, type Movement } from '../payments/apply';
import { queueCommand } from '../payments/gateway';
import { formatUsd } from '../payments/match';
import { spacetimedb } from '../schema';
import { closeCashExceptions } from './matches';

/** Business days a payment nobody can identify waits for a claim before it is returned. */
export const RETURN_DAYS = 5;

const sender = (m: Movement) => m.origName || (m.origAccount ? `${m.origAccount.slice(0, 8)}…` : 'an unknown sender');
const isCrypto = (m: Movement) => m.rail === 'USDC' || m.platformAccount === 'wallet';

/** Unknown money landed and was parked as unapplied cash: give it a return-by date and wake Iris. */
export function parkUnidentified(ctx: Ctx, m: Movement, workItemId: bigint) {
  const dueOn = addDays(simDate(ctx), RETURN_DAYS);
  ctx.db.deadline.insert({
    id: 0n, kind: 'return_by', clientId: BOOKS, workItemId, startedOn: simDate(ctx), dueOn, status: 'open', clause: '',
    note: `${m.id}`,
  });
  const text = `Couldn't tell who sent ${formatUsd(m.amountCents)} ${m.rail === 'USDC' ? 'USDC' : 'by wire'} from ${sender(m)}. Parked as unapplied cash until ${dueOn}.`;
  step(ctx, { clientId: BOOKS, actor: 'payment', text, opens: text, workItemId });
  route(ctx, 'unidentified', BOOKS, text);
}

/** The open return-by deadline for a parked payment, if any. */
function returnBy(ctx: Ctx, movementId: string) {
  return [...ctx.db.deadline.clientId.filter(BOOKS)].find((d) => d.kind === 'return_by' && d.note === movementId && (d.status === 'open' || d.status === 'due'));
}

/** People may act any time; an agent only once the return-by date has passed. */
function mayResolve(ctx: Ctx, m: Movement) {
  const role = requireRole(ctx, ['CONTROLLER', 'ACCOUNTANT', 'ADMIN', 'AGENT']);
  if (role === 'AGENT' && returnBy(ctx, m.id)?.status !== 'due') throw new SenderError(`${m.bankRef} can be claimed until its return-by date; wait for it`);
  if (m.direction !== 'in' || m.matchStatus !== 'exception') throw new SenderError(`${m.bankRef} is ${m.matchStatus}, not waiting to be placed`);
}

function resolved(ctx: Ctx, m: Movement, status: string, cause: string) {
  setMatchStatus(ctx, m.id, status);
  closeCashExceptions(ctx, m.id, cause);
  const d = returnBy(ctx, m.id);
  if (d) ctx.db.deadline.id.update({ ...d, status: 'met' });
}

/** Send unidentified cash back where it came from, through the bank. Not possible for crypto from here. */
export const returnCash = spacetimedb.reducer({ movementId: t.string(), reason: t.string() }, (ctx, { movementId, reason }) => {
  const m = ctx.db.cashMovement.id.find(movementId);
  if (!m) throw new SenderError(`unknown movement ${movementId}`);
  mayResolve(ctx, m);
  if (isCrypto(m)) throw new SenderError('crypto cannot be sent back from here: the bank has no blockchain. Keep it as unclaimed cash instead');
  const item = createWorkItem(ctx, {
    kind: 'RETURN', clientId: BOOKS, subjectId: m.id, amountCents: m.amountCents,
    title: `Return ${formatUsd(m.amountCents)} to ${sender(m)}`,
    proposal: { movementId: m.id }, reasoning: reason.trim() || `Nobody claimed it by the return-by date.`,
    policyRef: 'pol-001', confidence: 1, requiredRole: 'ACCOUNTANT', autoApplied: true,
  });
  queueCommand(ctx, `RETURN:${m.id}`, {
    type: 'RETURN_PAYMENT', movementId: m.id, bankRef: m.bankRef, platformAccount: m.platformAccount, amountCents: m.amountCents,
    origName: m.origName, origAccount: m.origAccount, on: simDate(ctx),
  }, item.id);
  resolved(ctx, m, 'returning', `returned to ${sender(m)}`);
});

/**
 * Crypto nobody claimed: it stays on the books as unclaimed cash (a liability to the sender) and
 * stops waiting on a person. Claiming it later still works through Match to client.
 */
export const keepUnclaimed = spacetimedb.reducer({ movementId: t.string(), reason: t.string() }, (ctx, { movementId, reason }) => {
  const m = ctx.db.cashMovement.id.find(movementId);
  if (!m) throw new SenderError(`unknown movement ${movementId}`);
  mayResolve(ctx, m);
  resolved(ctx, m, 'unclaimed', `kept as unclaimed cash`);
  const who = actorOf(ctx)?.role === 'AGENT' ? 'learning' : 'person';
  audit(ctx, { action: 'CASH_UNCLAIMED', subjectType: 'cash_movement', subjectId: m.id, toState: 'unclaimed', detail: `${formatUsd(m.amountCents)} from ${sender(m)}: ${reason.trim() || 'nobody claimed it'}` });
  step(ctx, {
    clientId: BOOKS, actor: who, opens: true,
    text: `Kept ${formatUsd(m.amountCents)} from ${sender(m)} as unclaimed cash. It stays on the books until someone claims it.`, reason,
  });
});
