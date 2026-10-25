import type { TaskContext } from '../types';
import { correctionFor, findCauses, likelyOwners, type BooksFacts } from './trace';

/** Tasks about the platform's own books carry this in place of a client id (spacetime/src/agents.ts). */
export const BOOKS = 'books';

const usd = (c: bigint) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const abs = (n: bigint) => (n < 0n ? -n : n);

/** Iris on the books: trace and correct a break, find the owner of money nobody could identify. */
export async function handleBooks(ctx: TaskContext): Promise<string> {
  const done = [await correctBreak(ctx), ...(await placeUnidentified(ctx))].filter(Boolean);
  return done.join(' · ') || 'books tie, nothing unidentified';
}

async function correctBreak(ctx: TaskContext): Promise<string> {
  const db = ctx.conn.db;
  const run = [...db.tieOutRun.iter()].reduce<{ id: bigint; status: string } | undefined>((a, r) => (!a || r.id > a.id ? r : a), undefined);
  if (!run || run.status !== 'break') return '';
  const off = new Map<string, bigint>();
  for (const b of db.tieOutBreak.runId.filter(run.id)) if (b.kind === 'unexplained') off.set(b.area, b.amountCents);
  const gap = [...off.values()].reduce((s, v) => s + abs(v), 0n);
  const facts: BooksFacts = {
    off,
    movements: [...db.cashMovement.iter()].map((m) => ({ ...m, reverses: m.reverses ?? undefined })),
    applications: [...db.paymentApplication.iter()],
    ledger: [...db.ledgerEntry.iter()],
    pending: new Set(
      [...db.gatewayCommand.type.filter('POST_JOURNAL')]
        .filter((c) => c.status === 'queued' || c.status === 'executing')
        .map((c) => JSON.parse(c.actionJson).journal.journalId as string),
    ),
  };
  const findings = findCauses(facts);
  if (!findings.length) {
    if ([...off.keys()].some((a) => a.startsWith('cash:'))) {
      await ctx.say(`The books are off by ${usd(gap)} on a bank account. Cash is the bank's call, so it waits for Maya.`);
    } else {
      await ctx.say(`Couldn't trace the ${usd(gap)} difference to a payment yet. It stays on Maya's alert list.`);
    }
    return 'break not traced';
  }
  const { lines, closes, explainedCents } = correctionFor(facts, findings);
  const shown = findings.slice(0, 4).map((f) => `- ${f.text}`);
  if (findings.length > 4) shown.push(`- And ${findings.length - 4} more like these.`);
  shown.push(`- The fix moves ${usd(explainedCents)} out of both receivables and unapplied cash. Cash is untouched.`);
  const reasoning = shown.join('\n');
  await ctx.say(`Traced the ${usd(gap)} difference to ${findings.length} payment${findings.length === 1 ? '' : 's'} booked wrong.`, reasoning);
  const refusal = await ctx.attempt(`correct the books by ${usd(explainedCents)}`, () => ctx.conn.reducers.proposeAdjustingJournal({
    memo: `${findings.length} payment${findings.length === 1 ? '' : 's'} booked wrong`,
    reasoning, evidence: findings.map((f) => f.ref), lines, confidence: closes ? 0.95 : 0.6,
  }));
  return refusal ? 'correction refused' : closes ? `books corrected (${usd(explainedCents)})` : 'partial correction sent to a controller';
}

async function placeUnidentified(ctx: TaskContext): Promise<string[]> {
  const db = ctx.conn.db;
  const parked = [...db.workItem.iter()].filter((w) => w.kind === 'UNIDENTIFIED_CASH' && w.state !== 'WITHDRAWN');
  const clients = [...db.client.iter()];
  const invoices = [...db.invoice.iter()]
    .filter((i) => i.status !== 'void' && i.status !== 'disputed' && i.paidCents < i.amountCents)
    .map((i) => ({ id: i.id, clientId: i.clientId, owedCents: i.amountCents - i.paidCents }));
  const said = new Set([...db.episodeStep.iter()].filter((s) => s.actor === 'learning').map((s) => s.text));
  const out: string[] = [];
  for (const w of parked) {
    const m = db.cashMovement.id.find(w.subjectId);
    if (!m || m.direction !== 'in' || m.matchStatus !== 'exception') continue;
    const sender = m.origName || `wallet ${m.origAccount.slice(0, 8)}…`;
    const deadline = [...db.deadline.clientId.filter(BOOKS)].find((d) => d.kind === 'return_by' && d.note === m.id);
    const crypto = m.rail === 'USDC' || m.platformAccount === 'wallet';

    if (deadline?.status === 'due') {
      const why = `Nobody claimed it by ${deadline.dueOn}.`;
      const refusal = crypto
        ? await ctx.attempt(`keep ${usd(m.amountCents)} from ${sender} as unclaimed cash`, () => ctx.conn.reducers.keepUnclaimed({ movementId: m.id, reason: why }))
        : await ctx.attempt(`return ${usd(m.amountCents)} to ${sender}`, () => ctx.conn.reducers.returnCash({ movementId: m.id, reason: why }));
      out.push(refusal ? `${m.bankRef} could not be resolved` : crypto ? `${m.bankRef} kept as unclaimed` : `${m.bankRef} returned`);
      continue;
    }

    const owners = likelyOwners(m, clients, invoices);
    const strong = owners.filter((o) => o.strong);
    if (strong.length === 1) {
      const o = strong[0]!;
      await ctx.say(`${usd(m.amountCents)} from ${sender} belongs to ${o.client.name}: ${o.why}.`);
      const refusal = await ctx.attempt(`match ${usd(m.amountCents)} from ${sender} to ${o.client.name}`, () => ctx.conn.reducers.proposePaymentMatch({
        movementId: m.id, clientId: o.client.id, reasoning: `Iris traced it: ${o.why}.`,
        evidenceJson: JSON.stringify([{ signal: 'amount_and_name', detail: o.why }]), confidence: 0.9, rmNoteId: undefined,
      }));
      out.push(refusal ? `${m.bankRef} match refused` : `${m.bankRef} matched to ${o.client.name}`);
      continue;
    }
    const by = deadline ? ` by ${deadline.dueOn}` : '';
    const text = owners.length
      ? `${usd(m.amountCents)} from ${sender} could be ${owners.map((o) => o.client.name).join(' or ')}. Not sure enough to apply it, so a person confirms${by}.`
      : `Nobody on file sent ${usd(m.amountCents)} from ${sender} and no client owes exactly that. ${crypto ? `It is kept as unclaimed cash${by}` : `It goes back${by}`} unless someone claims it.`;
    if (!said.has(text)) await ctx.say(text, owners.map((o) => `- ${o.client.name}: ${o.why}.`).join('\n'));
    out.push(`${m.bankRef} waiting for a claim`);
  }
  return out;
}
