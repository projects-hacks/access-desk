/**
 * Iris on the books: why the ledger and operations disagree, traced to the payments behind it,
 * and the correcting entry that would close it. Pure, so it is unit-tested; agents/learning.ts acts.
 */

export const RECEIVABLES = '1200';
export const UNAPPLIED_CASH = '2300';

export interface Line { account: string; debitCents: bigint; creditCents: bigint }
export interface Movement {
  id: string; bankRef: string; direction: string; reverses?: string; isHistory: boolean; matchStatus: string;
  amountCents: bigint; rail: string; origName: string; origAccount: string; refs: string[]; platformAccount: string;
}
export interface Application { id: bigint; movementId: string; method: string; reversed: boolean; amountCents: bigint }
export interface LedgerLine { journalId: string; accountCode: string; debitCents: bigint; creditCents: bigint; ref: string }

export interface BooksFacts {
  /** Unexplained differences of the latest tie-out, by area ("receivables", "unapplied", "cash:…"): operations minus ledger. */
  off: Map<string, bigint>;
  movements: Movement[];
  applications: Application[];
  ledger: LedgerLine[];
  /** Journals queued for the gateway but not posted yet. */
  pending: Set<string>;
}

export interface Finding { ref: string; amountCents: bigint; text: string; lines: Line[] }

const usd = (c: bigint) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ours = (a: Application) => a.method !== 'prior' && a.method !== 'write_off';
const correction = (amount: bigint): Line[] => [
  { account: UNAPPLIED_CASH, debitCents: amount, creditCents: 0n },
  { account: RECEIVABLES, debitCents: 0n, creditCents: amount },
];

/** Every known way a payment can leave receivables and unapplied cash out of step, found in the data. */
export function findCauses(f: BooksFacts): Finding[] {
  const out: Finding[] = [];
  const corrected = (ref: string) => f.ledger.some((l) => l.journalId.startsWith('JE-ADJ') && (l.journalId.endsWith(ref) || l.ref.split(' ').includes(ref)));
  const byRef = new Map(f.movements.map((m) => [m.bankRef, m]));

  // A returned payment we had applied ourselves, booked to receivables twice.
  for (const m of f.movements) {
    if (m.direction !== 'out' || !m.reverses || m.isHistory || corrected(m.bankRef)) continue;
    const original = byRef.get(m.reverses);
    if (!original) continue;
    const applied = f.applications.filter((a) => a.movementId === original.id && a.reversed && ours(a)).reduce((s, a) => s + a.amountCents, 0n);
    const doubled = f.ledger.filter((l) => l.journalId === `JE-R-${m.bankRef}` && l.accountCode === RECEIVABLES).reduce((s, l) => s + l.debitCents, 0n);
    const amount = applied < doubled ? applied : doubled;
    if (amount > 0n) out.push({ ref: m.bankRef, amountCents: amount, text: `The return of ${original.bankRef} (${usd(amount)}) was booked to receivables twice.`, lines: correction(amount) });
  }

  // Cash applied to invoices whose application journal never reached the ledger.
  for (const m of f.movements) {
    if (m.direction !== 'in' || m.isHistory || corrected(m.bankRef)) continue;
    const fresh = f.applications.filter((a) => a.movementId === m.id && ours(a) && !a.reversed).sort((a, b) => Number(a.id - b.id));
    if (!fresh.length) continue;
    const journal = `JE-AP-${m.bankRef}-${fresh[0]!.id}`;
    if (f.pending.has(journal) || f.ledger.some((l) => l.journalId === journal)) continue;
    const amount = fresh.reduce((s, a) => s + a.amountCents, 0n);
    out.push({ ref: m.bankRef, amountCents: amount, text: `${m.bankRef} (${usd(amount)}) was applied to invoices but its journal never reached the ledger.`, lines: correction(amount) });
  }
  return out;
}

/** What a set of lines does to each area's ledger figure (receivables carry a debit balance, unapplied a credit balance). */
export function effectOf(lines: Line[]): Map<string, bigint> {
  const effect = new Map<string, bigint>();
  for (const l of lines) {
    const area = l.account === RECEIVABLES ? 'receivables' : l.account === UNAPPLIED_CASH ? 'unapplied' : '';
    if (!area) continue;
    const d = area === 'receivables' ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
    effect.set(area, (effect.get(area) ?? 0n) + d);
  }
  return effect;
}

/** The entry for the findings, merged to one line per account, and whether it closes every difference exactly. */
export function correctionFor(f: BooksFacts, findings: Finding[]): { lines: Line[]; closes: boolean; explainedCents: bigint } {
  const total = findings.reduce((s, x) => s + x.amountCents, 0n);
  const lines = total > 0n ? correction(total) : [];
  const effect = effectOf(lines);
  const closes = total > 0n && [...f.off].every(([area, before]) => before - (effect.get(area) ?? 0n) === 0n);
  return { lines, closes, explainedCents: total };
}

export interface Client { id: string; name: string; legalName: string }
export interface OpenInvoice { id: string; clientId: string; owedCents: bigint }

/**
 * Who most likely sent money nobody could identify: a client owing exactly that amount on one
 * invoice, or in total, ranked up when the sender's name shares words with the client's.
 */
export function likelyOwners(m: Movement, clients: Client[], invoices: OpenInvoice[]): { client: Client; why: string; strong: boolean }[] {
  const words = (s: string) => new Set(s.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 2 && !['LLC', 'INC', 'LTD', 'THE', 'CAPITAL', 'FUND'].includes(w)));
  const sender = words(m.origName);
  const out: { client: Client; why: string; strong: boolean }[] = [];
  for (const c of clients) {
    const owed = invoices.filter((i) => i.clientId === c.id);
    const single = owed.find((i) => i.owedCents === m.amountCents);
    const total = owed.reduce((s, i) => s + i.owedCents, 0n);
    const named = [...words(c.legalName)].some((w) => sender.has(w));
    if (single) out.push({ client: c, why: `${single.id} is open for exactly ${usd(m.amountCents)}${named ? ' and the sender name matches' : ''}`, strong: named });
    else if (total === m.amountCents && total > 0n) out.push({ client: c, why: `owes exactly ${usd(m.amountCents)} in total${named ? ' and the sender name matches' : ''}`, strong: named });
  }
  return out;
}
