import { loadView, loadWorld } from '../access/load';
import type { ClientView, World } from '../access/model';
import type { RmReading } from '../access/pushback';
import { loadBook } from '../credit/load';
import { detect } from '../credit/detectors';
import type { ClientBook, Flag } from '../credit/model';
import type { Finding, Verdict } from '../exploit/model';
import { loadRows } from '../exploit/load';
import { rulesVerdict } from '../exploit/judge';
import { findingsFor, type FlagRow, type ScanInput } from '../exploit/scan';
import type { DbConnection } from '../module_bindings';

/**
 * What an agent's read tools show: one client's rows taken from the live cache when its session
 * starts (plain data, money in cents). Tools only format this, so a session sees a consistent
 * picture and nothing here can reach another client, except `similar`, which is other clients'
 * past decisions by design.
 */

export interface HoldRow { amountCents: number; reason: string; clause: string; invoiceIds: string[]; status: string }
export interface WaitRow { on: string; code: string; reason: string }
export interface ApplicationRow { invoiceId: string; movementId: string; amountCents: number; method: string; reversed: boolean }
export interface FlagInfo { id: string; pattern: string; status: string; score: number; months: number }

export interface SimilarCase {
  client: string;
  tier: number;
  /** Why it looks like this client: same pattern, same tier, similar overdue. */
  matched: string[];
  decidedOn: string;
  situation: string;
  proposed: string;
  decision: string;
  reason: string;
  outcome: string;
  source: string;
}

export interface ExploitFacts {
  book: ClientBook;
  findings: Finding[];
  /** What the rules alone would label each finding. */
  verdicts: Map<string, Verdict>;
  checks: Flag[];
  scanInput: ScanInput;
  stored: Map<string, FlagRow>;
}

export interface Facts {
  today: string;
  view: ClientView;
  world: World;
  status: string;
  holds: HoldRow[];
  waits: WaitRow[];
  applications: ApplicationRow[];
  flags: FlagInfo[];
  similar: SimilarCase[];
  exploit?: ExploitFacts;
}

const num = (n: bigint | number) => Number(n);

export function overdueCents(conn: DbConnection, clientId: string, today: string): number {
  let total = 0;
  for (const i of conn.db.invoice.clientId.filter(clientId)) {
    if (i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents) total += num(i.amountCents - i.paidCents);
  }
  return total;
}

/** 0 = nothing overdue, then four bands by amount. */
export const band = (cents: number) => (cents <= 0 ? 0 : cents < 2_500_000 ? 1 : cents < 10_000_000 ? 2 : cents < 50_000_000 ? 3 : 4);
const BAND_WORDS = ['nothing overdue', 'under $25,000 overdue', '$25,000 to $100,000 overdue', '$100,000 to $500,000 overdue', 'over $500,000 overdue'];

const SIMILAR_LIMIT = 5;

/**
 * Past decisions on OTHER clients that look like this one, best match first: the same fired
 * pattern, then the same tier, then the same overdue band. Never this client's own.
 */
export function similarCases(conn: DbConnection, clientId: string, today: string, extraPatterns: string[] = []): SimilarCase[] {
  const me = conn.db.client.id.find(clientId);
  const patterns = new Set([...[...conn.db.exploitFlag.clientId.filter(clientId)].map((f) => f.pattern), ...extraPatterns]);
  const myBand = band(overdueCents(conn, clientId, today));
  const profile = new Map<string, { name: string; tier: number; patterns: Set<string>; band: number }>();
  const of = (id: string) => {
    let p = profile.get(id);
    if (!p) {
      const c = conn.db.client.id.find(id);
      p = { name: c?.name ?? id, tier: c?.tier ?? 0, patterns: new Set([...conn.db.exploitFlag.clientId.filter(id)].map((f) => f.pattern)), band: band(overdueCents(conn, id, today)) };
      profile.set(id, p);
    }
    return p;
  };
  const ranked: { score: number; row: SimilarCase }[] = [];
  for (const r of conn.db.precedent.iter()) {
    if (r.clientId === clientId || !r.decision) continue;
    const p = of(r.clientId);
    const shared = [...p.patterns].filter((x) => patterns.has(x));
    const sameTier = !!me && p.tier === me.tier;
    const sameBand = myBand > 0 && p.band === myBand;
    const score = shared.length * 100 + (sameTier ? 10 : 0) + (sameBand ? 1 : 0);
    if (!score) continue;
    const matched = [...shared.map((x) => `same pattern: ${x.replace(/_/g, ' ')}`), ...(sameTier ? [`same tier (${p.tier})`] : []), ...(sameBand ? [`similar amount: ${BAND_WORDS[p.band]}`] : [])];
    ranked.push({
      score: score * 1e6 + Number(r.decidedOn.replace(/-/g, '')) % 1e6,
      row: { client: p.name, tier: p.tier, matched, decidedOn: r.decidedOn, situation: r.situation, proposed: r.proposed, decision: r.decision, reason: r.overrideReason, outcome: r.outcome, source: r.source },
    });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, SIMILAR_LIMIT).map((r) => r.row);
}

/** One client's facts for Sage (and the shared read tools). */
export function sageFacts(conn: DbConnection, view: ClientView, world: World, extraPatterns: string[] = []): Facts {
  const id = view.client.id;
  const today = world.today;
  const applications: ApplicationRow[] = [];
  for (const inv of view.invoices) {
    for (const a of conn.db.paymentApplication.invoiceId.filter(inv.id)) {
      applications.push({ invoiceId: a.invoiceId, movementId: a.movementId, amountCents: num(a.amountCents), method: a.method, reversed: a.reversed });
    }
  }
  const waits = [...conn.db.auditEvent.clientId.filter(id)].filter((e) => e.action === 'AGENT_WAITED').sort((a, b) => Number(b.id - a.id)).slice(0, 5)
    .map((e) => ({ on: e.simDate, code: e.toState, reason: e.detail }));
  const flags = [...conn.db.exploitFlag.clientId.filter(id)].map((f) => ({ id: f.id, pattern: f.pattern, status: f.status, score: f.score, months: f.months }));
  return {
    today, view, world, status: conn.db.client.id.find(id)?.status ?? '',
    holds: [...conn.db.hold.clientId.filter(id)].map((h) => ({ amountCents: num(h.amountCents), reason: h.reason, clause: h.clause, invoiceIds: h.invoiceIds, status: h.status })),
    waits, applications, flags, similar: similarCases(conn, id, today, extraPatterns),
  };
}

/** Facts for Rowan: Sage's view plus the engine's book, findings and detector measurements. */
export function rowanFacts(conn: DbConnection, clientId: string, today: string, readings = new Map<number, RmReading>()): Facts | undefined {
  const view = loadView(conn, clientId);
  const book = loadBook(conn, clientId, today);
  if (!view || !book) return undefined;
  const world = loadWorld(conn, view, today, readings);
  const rows = loadRows(conn);
  const findings = findingsFor(book, rows, today);
  const work = [...conn.db.workItem.clientId.filter(clientId)];
  const flags = [...conn.db.exploitFlag.clientId.filter(clientId)];
  const base = sageFacts(conn, view, world, findings.map((f) => f.check));
  return {
    ...base,
    exploit: {
      book, findings, verdicts: new Map(findings.map((f) => [f.id, rulesVerdict(f)])), checks: detect(book),
      scanInput: { book, rows, raisedSubjects: new Set(work.map((w) => w.subjectId)), clearedFlags: new Set(flags.filter((f) => f.status === 'cleared').map((f) => f.id)), today },
      stored: new Map(flags.map((f) => [f.id, f])),
    },
  };
}
