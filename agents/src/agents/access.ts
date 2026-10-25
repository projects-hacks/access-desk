import { loadView, loadWorld } from '../access/load';
import type { ClientView, Move, NoticeMove, Plan, Wait, World } from '../access/model';
import { wordNotice } from '../access/notice';
import { ESCALATION_DAYS, ladders, plan } from '../access/plan';
import { answered, overdueInvoices } from '../access/helpers';
import { providerName, readNote, type RmReading } from '../access/pushback';
import { env } from '../env';
import { sageFacts } from '../tools/facts';
import { droidChoice, investigateSage, needsJudgment, rulesChoice, shadowLine } from '../tools/investigate';
import type { Agent, TaskContext } from '../types';

/**
 * Recover first, restrict the unpaid product first, gentlest step first; restore on payment.
 * Looks at one client: reads its RM notes, decides at most one move (plan.ts), and proposes it
 * through the action reducers, which check the contract, capabilities and policy and may refuse.
 */

/** RM notes already read, so a note nobody has to answer isn't read again on every wake. */
const readings = new Map<string, RmReading>();

export interface Prep {
  view: ClientView;
  world: World;
  plan: Plan;
}

/** Reads the client's RM notes and plans: what the rules would do, before anyone acts. */
export async function prepare(ctx: TaskContext): Promise<Prep | undefined> {
  const view = loadView(ctx.conn, ctx.task.clientId);
  if (!view) return undefined;
  const read = new Map<number, RmReading>();
  for (const note of view.rmNotes) {
    if (answered(view, note.id)) continue;
    const key = `${view.client.id}:${note.id}:${note.text}`;
    let reading = readings.get(key);
    if (!reading) readings.set(key, (reading = await readNote(ctx.ask, note.text, view.client.name, ctx.today)));
    read.set(note.id, reading);
  }
  const world = loadWorld(ctx.conn, view, ctx.today, read);
  return { view, world, plan: plan(view, world, ladders(world.capability), ESCALATION_DAYS) };
}

export const access: Agent = {
  name: 'access',
  concurrency: 4,
  async handle(ctx) {
    const prep = await prepare(ctx);
    if (!prep) return `unknown client ${ctx.task.clientId}`;
    const { view, plan: p } = prep;
    const mode = env.AGENT_MODE;
    if (mode === 'rules' || !needsJudgment(p)) return rulesPass(ctx, view, p);
    const facts = sageFacts(ctx.conn, view, prep.world);

    if (mode === 'shadow') {
      // The rules act as always; the Droid agent only says what it would have done.
      const shadow = investigateSage(ctx, { plan: p, facts }, 'shadow');
      const summary = await rulesPass(ctx, view, p);
      console.log(shadowLine('access', view.client.name, rulesChoice(p), await shadow));
      return summary;
    }

    const records = await bookkeeping(ctx, view, p);
    const inv = await investigateSage(ctx, { plan: p, facts }, 'droid');
    if (inv.decided) return [records, `${droidChoice(inv.outcomes).text} (Droid, ${inv.calls.length} tool calls)`].filter(Boolean).join(' · ');
    console.log(`[access] ${view.client.name}: Droid gave no decision (${inv.error ?? 'no action taken'}), rules take over`);
    return rulesPass(ctx, view, p, records);
  },
};

/** Precedents and investigations the rules record whatever else happens. */
async function bookkeeping(ctx: TaskContext, view: ClientView, p: Plan): Promise<string> {
  for (const move of p.bookkeeping) await execute(ctx, view, move);
  return p.bookkeeping.length ? `${p.bookkeeping.length} records` : '';
}

/** Today's behaviour: bookkeeping, then the one decision (or a recorded wait) the rules chose. */
async function rulesPass(ctx: TaskContext, view: ClientView, p: Plan, records?: string): Promise<string> {
  const done: string[] = [];
  const kept = records ?? (await bookkeeping(ctx, view, p));
  if (kept) done.push(kept);
  if (p.decision) {
    const refusal = await execute(ctx, view, p.decision);
    done.push(refusal ? `${p.decision.summary} refused` : proposed(p.decision));
  } else if (p.wait) {
    if (p.recordWait) await recordWait(ctx, view, p.wait);
    done.push(`waiting (${p.wait.code})`);
  } else if (!overdueInvoices(view, ctx.today).length && !ctx.task.reason.startsWith('Daily review') && !p.bookkeeping.length) {
    await say(ctx, `${view.client.name} is current. Nothing to restrict.`);
  }
  return done.join(' · ') || 'nothing to do';
}

const proposed = (move: Move) => (move.kind === 'restriction' || move.kind === 'custody_debit' || move.kind === 'restore' ? `${move.summary} proposed` : move.summary);

/** Puts a conclusion on the panel; a failure there must not stop (or repeat) the action it announces. */
async function say(ctx: TaskContext, text: string, reason?: string) {
  try {
    await ctx.say(text, reason);
  } catch {}
}

async function recordWait(ctx: TaskContext, view: ClientView, wait: Wait) {
  await ctx.attempt(`record why ${view.client.name} was not acted on`, () => ctx.conn.reducers.recordWait({ clientId: view.client.id, code: wait.code, reason: wait.reason }));
}

/** Makes the move's reducer call. Returns the refusal, or undefined when it went through. */
export async function execute(ctx: TaskContext, view: ClientView, move: Move): Promise<string | undefined> {
  const clientId = view.client.id;
  const { reducers } = ctx.conn;
  switch (move.kind) {
    case 'restriction':
      await say(ctx, move.headline, move.why);
      return ctx.attempt(move.what, () => reducers.proposeRestrictionWithBoundaries({
        clientId, lever: move.lever, step: move.step, reasoning: move.reasoning, policyRef: move.policyRef, confidence: move.confidence,
        boundariesJson: JSON.stringify(move.boundaries),
      }));
    case 'custody_debit':
      await say(ctx, move.headline, move.reasoning);
      return ctx.attempt(move.what, () => reducers.proposeCustodyDebit({
        clientId, invoiceIds: move.invoiceIds, reasoning: move.reasoning, policyRef: move.policyRef, confidence: move.confidence,
      }));
    case 'restore':
      await say(ctx, move.headline, move.reasoning);
      return ctx.attempt(move.what, () => reducers.proposeRestore({
        clientId, lever: move.lever, reasoning: move.reasoning, policyRef: move.policyRef, confidence: move.confidence,
      }));
    case 'notice':
      return sendNotice(ctx, view, move);
    case 'payment_match': {
      const refusal = await ctx.attempt(move.summary, () => reducers.proposePaymentMatch({
        movementId: move.movementId, clientId, reasoning: move.reasoning, evidenceJson: JSON.stringify([move.evidence]),
        confidence: move.evidence.confidence, rmNoteId: BigInt(move.rmNoteId),
      }), 'tell the RM it is with an accountant');
      if (refusal) {
        await execute(ctx, view, move.reply);
        return refusal;
      }
      return execute(ctx, view, move.after);
    }
    case 'case':
      return ctx.attempt(move.summary, () => reducers.proposeWorkItem({
        kind: move.proposal.kind, clientId, subjectId: move.proposal.subjectId, title: move.proposal.title,
        amountCents: BigInt(Math.round(move.proposal.amountCents)), proposalJson: JSON.stringify(move.proposal.proposal),
        reasoning: move.proposal.reasoning, policyRef: move.proposal.policyRef, clausesCited: move.proposal.clausesCited, boundariesJson: '[]',
        confidence: move.proposal.confidence, requiredRole: 'CONTROLLER',
      }));
    case 'precedent':
      return ctx.attempt(move.summary, () => reducers.upsertPrecedent({
        row: { ...move.row, workItemId: move.row.workItemId === undefined ? undefined : BigInt(move.row.workItemId) },
      }));
    case 'investigation':
      return ctx.attempt(move.summary, () => reducers.recordInvestigation({ workItemId: BigInt(move.workItemId), steps: move.steps }));
  }
}

/** The model words the notice; the template goes out unless its wording passes the number check. */
async function sendNotice(ctx: TaskContext, view: ClientView, move: NoticeMove): Promise<string | undefined> {
  const { text, by } = await wordNotice(ctx.ask, move.channel, move.body, `Client: ${view.client.name}`);
  const reasoning = by ? `${move.reasoning}\n- Wording by ${providerName(by)}, every number checked against the client's facts.` : move.reasoning;
  return ctx.attempt(move.summary, () => ctx.conn.reducers.proposeNotice({
    clientId: view.client.id, channel: move.channel, body: text, reasoning, policyRef: move.policyRef, confidence: move.confidence,
  }));
}
