import type { DbConnection } from '../module_bindings';
import type { CashMovement } from '../module_bindings/types';
import type { CashRow, ClientView, DecisionRow, World } from './model';
import type { RmReading } from './pushback';

/** One client's rows from the live cache, with money as numbers (cents). */

const num = (n: bigint | number) => Number(n);
const DECISIONS = new Set(['REJECTED', 'APPROVED', 'WITHDRAWN']);
const UNPLACED = new Set(['unmatched', 'exception']);

const cashRow = (m: CashMovement): CashRow => ({
  id: m.id, amountCents: num(m.amountCents), rail: m.rail, bankRef: m.bankRef, origName: m.origName, origAccount: m.origAccount, valueOn: m.valueOn,
  status: m.status, matchStatus: m.matchStatus, memo: m.memo, remittance: m.remittance, refs: m.refs, returnCode: m.returnCode,
});

/** Whether the movement's references or sender name this client (its id, invoices, name or a known payer account). */
function paidBy(m: { refs: string[]; origName: string; origAccount: string }, names: Set<string>, refs: Set<string>): boolean {
  if (m.refs.some((r) => refs.has(r))) return true;
  return [m.origAccount, m.origName.toLowerCase()].some((n) => n && names.has(n));
}

function claim(conn: DbConnection, clientId: string) {
  const c = conn.db.client.id.find(clientId);
  const refs = new Set([clientId, ...[...conn.db.invoice.clientId.filter(clientId)].map((i) => i.id)]);
  const names = new Set<string>();
  for (const p of conn.db.payerIdentity.clientId.filter(clientId)) names.add(p.value).add(p.value.toLowerCase());
  if (c) names.add(c.name.toLowerCase()).add(c.legalName.toLowerCase());
  return { names, refs };
}

export function loadView(conn: DbConnection, clientId: string): ClientView | undefined {
  const c = conn.db.client.id.find(clientId);
  if (!c) return undefined;
  const k = conn.db.contract.clientId.find(clientId);
  const workItems = [...conn.db.workItem.clientId.filter(clientId)].sort((a, b) => Number(a.id - b.id)).map((w) => ({
    id: num(w.id), kind: w.kind, subjectId: w.subjectId, state: w.state, title: w.title, requiredRole: w.requiredRole, policyRef: w.policyRef,
    amountCents: num(w.amountCents), proposalJson: w.proposalJson,
  }));
  const byId = new Map(workItems.map((w) => [w.id, w]));

  const rejections: DecisionRow[] = [];
  const approvals: DecisionRow[] = [];
  const withdrawals: DecisionRow[] = [];
  const events = [...conn.db.auditEvent.clientId.filter(clientId)].sort((a, b) => Number(a.id - b.id));
  for (const e of events) {
    const item = e.workItemId === undefined ? undefined : byId.get(num(e.workItemId));
    if (!DECISIONS.has(e.toState) || !e.allowed || !item) continue;
    const row = { workItemId: item.id, workItemKind: item.kind, toState: e.toState, simDate: e.simDate, detail: e.detail, action: e.action };
    (e.toState === 'REJECTED' ? rejections : e.toState === 'APPROVED' ? approvals : withdrawals).push(row);
  }

  const { names, refs } = claim(conn, clientId);
  const cash = [...conn.db.cashMovement.iter()].filter((m) => !m.isHistory && m.direction === 'in' && paidBy(m, names, refs)).map(cashRow);

  return {
    client: { id: c.id, name: c.name, legalName: c.legalName, tier: c.tier, strategic: c.strategic, relationshipManager: c.relationshipManager, renewalOn: c.renewalOn },
    contract: k ? { graceDays: k.graceDays, cureDays: k.cureDays, crossDefault: k.crossDefault } : undefined,
    invoices: [...conn.db.invoice.clientId.filter(clientId)].map((i) => ({
      id: i.id, product: i.product, issuedOn: i.issuedOn, dueOn: i.dueOn, amountCents: num(i.amountCents), paidCents: num(i.paidCents), paidOn: i.paidOn, status: i.status,
    })),
    disputes: [...conn.db.dispute.clientId.filter(clientId)].map((d) => ({ invoiceId: d.invoiceId, openedOn: d.openedOn, status: d.status })),
    clauses: [...conn.db.contractClause.clientId.filter(clientId)].map((x) => ({ clause: x.clause, kind: x.kind, allowed: x.allowed, text: x.text })),
    levers: [...conn.db.accessLever.clientId.filter(clientId)].map((l) => ({ lever: l.lever, state: l.state, detail: l.detail, workItemId: l.workItemId === undefined ? undefined : num(l.workItemId) })),
    custody: [...conn.db.custodyHolding.clientId.filter(clientId)].map((h) => ({ asset: h.asset, valueCents: num(h.valueCents) })),
    positions: [...conn.db.position.clientId.filter(clientId)].map((p) => ({ status: p.status, hedgeGroup: p.hedgeGroup, notionalCents: num(p.notionalCents) })),
    workItems,
    deadlines: [...conn.db.deadline.clientId.filter(clientId)].map((d) => ({ id: num(d.id), kind: d.kind, status: d.status, startedOn: d.startedOn, dueOn: d.dueOn, note: d.note })),
    payers: [...conn.db.payerIdentity.clientId.filter(clientId)].map((p) => ({ value: p.value })),
    flags: [...conn.db.exploitFlag.clientId.filter(clientId)].map((f) => ({ status: f.status, pattern: f.pattern })),
    rmNotes: [...conn.db.rmNote.clientId.filter(clientId)].sort((a, b) => Number(a.id - b.id)).map((n) => ({ id: num(n.id), author: n.author, text: n.text })),
    precedents: [...conn.db.precedent.clientId.filter(clientId)].map((p) => ({
      id: p.id, clientId: p.clientId, workItemId: p.workItemId === undefined ? undefined : num(p.workItemId), decidedOn: p.decidedOn, situation: p.situation,
      proposed: p.proposed, decision: p.decision, overrideReason: p.overrideReason, outcome: p.outcome, policyRef: p.policyRef, source: p.source,
    })),
    accessRequests: [...conn.db.accessRequest.clientId.filter(clientId)].map((r) => ({ action: r.action, decision: r.decision, allowedCents: num(r.allowedCents) })),
    cash,
    inTransit: cash.filter((m) => m.matchStatus === 'in_transit'),
    rejections, approvals, withdrawals,
  };
}

export function loadWorld(conn: DbConnection, v: ClientView, today: string, readings: Map<number, RmReading>): World {
  const platform = [...conn.db.platform.iter()][0];
  const failed = new Map<number, string>();
  for (const c of conn.db.gatewayCommand.status.filter('failed')) if (c.workItemId !== undefined) failed.set(num(c.workItemId), c.error ?? '');
  const lastWait = [...conn.db.auditEvent.clientId.filter(v.client.id)].filter((e) => e.action === 'AGENT_WAITED').sort((a, b) => Number(b.id - a.id))[0]?.detail;
  let unplaced: CashRow[] | undefined;
  return {
    today,
    wireInstructions: platform?.wireInstructions ?? '',
    capability: [...conn.db.capability.iter()].map((k) => ({ lever: k.lever, step: k.step, gentleness: k.gentleness, twoApprovers: k.twoApprovers })),
    policies: [...conn.db.policy.iter()].filter((p) => p.status === 'active').map((p) => ({ policyId: p.policyId, title: p.title, ruleJson: p.ruleJson })),
    failedCommands: failed,
    investigated: new Set(v.workItems.filter((w) => w.kind === 'NOVEL_CASE' && [...conn.db.investigationStep.workItemId.filter(BigInt(w.id))].length).map((w) => w.id)),
    lastWait, readings,
    unplaced: () => (unplaced ??= unplacedCash(conn)),
  };
}

/** Posted incoming cash that waits for a match and that no client claims by name, account or reference. */
function unplacedCash(conn: DbConnection): CashRow[] {
  const claims = [...conn.db.client.iter()].map((c) => claim(conn, c.id));
  return [...conn.db.cashMovement.iter()]
    .filter((m) => !m.isHistory && m.direction === 'in' && m.status === 'posted' && UNPLACED.has(m.matchStatus) && !claims.some((c) => paidBy(m, c.names, c.refs)))
    .map(cashRow);
}
