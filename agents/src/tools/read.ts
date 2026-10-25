import { z } from 'zod';
import { addDays, daysBetween, usd } from '../access/format';
import { answered, defaultedInvoices, openInvoices, overdueInvoices, owed, usdCash } from '../access/helpers';
import type { Facts } from './facts';
import { json } from './text';
import type { ToolDef } from './toolset';

/** The words for "what the agent checked" on the panel, by tool. */
export const CHECKED: Record<string, string[]> = {
  client_overview: ['contract', 'holds'], invoices: ['invoices'], payments: ['payments'], history: ['notes and history'],
  similar_cases: ['similar cases'], findings: ['findings'], pattern_checks: ['pattern checks'],
};

const $ = (cents: number) => usd(cents);

/** Read tools: they change nothing and take no client id, because the session is bound to one client. */
export function readTools(f: Facts): ToolDef[] {
  const { view, today } = f;
  const grace = view.contract?.graceDays ?? 0;
  const defaultedIds = new Set(defaultedInvoices(view, today).map((i) => i.id));
  const disputes = new Map(view.disputes.map((d) => [d.invoiceId, d]));
  const invoiceRow = (i: (typeof view.invoices)[number]) => {
    const left = i.amountCents - i.paidCents;
    return {
      id: i.id, product: i.product, amount: $(i.amountCents), paid: i.paidCents ? $(i.paidCents) : undefined, owed: left > 0 ? $(left) : undefined, issuedOn: i.issuedOn, dueOn: i.dueOn,
      daysLate: left > 0 && i.dueOn < today ? daysBetween(i.dueOn, today) : undefined, inDefault: defaultedIds.has(i.id) || undefined,
      defaultFrom: left > 0 && i.dueOn < today && !defaultedIds.has(i.id) && i.status !== 'disputed' ? addDays(i.dueOn, grace + 1) : undefined,
      dispute: disputes.get(i.id) ? `${disputes.get(i.id)!.status}, opened ${disputes.get(i.id)!.openedOn}` : undefined,
    };
  };

  return [
    {
      name: 'client_overview', readOnly: true, input: {},
      description: 'The client: name, tier, strategic or not, status, relationship manager, contract (grace and cure days, cross-default), clauses incl. set-off, cure and debit consent, access levers and their state, active holds, custody cash and holdings.',
      run: async () => {
        const held = f.holds.filter((h) => h.status === 'active');
        const cash = usdCash(view);
        const heldCents = held.reduce((s, h) => s + h.amountCents, 0);
        return json({
          today, name: view.client.name, tier: view.client.tier, strategic: view.client.strategic, status: f.status, relationshipManager: view.client.relationshipManager, renewalOn: view.client.renewalOn,
          contract: view.contract && { graceDays: view.contract.graceDays, cureDays: view.contract.cureDays, crossDefault: view.contract.crossDefault },
          clauses: view.clauses.map((c) => ({ section: c.clause, kind: c.kind.replace(/_/g, ' '), allowed: c.allowed, text: c.text })),
          levers: view.levers.map((l) => ({ lever: l.lever, state: l.state, detail: l.detail })),
          activeHolds: held.map((h) => ({ amount: $(h.amountCents), reason: h.reason, section: h.clause, invoices: h.invoiceIds })),
          custody: { usdCash: $(cash), heldAgainstIt: heldCents ? $(heldCents) : undefined, holdings: view.custody.map((h) => ({ asset: h.asset, value: $(h.valueCents) })) },
          openPositions: view.positions.filter((p) => p.status === 'open').length || undefined, hedgedBook: view.positions.some((p) => p.status === 'open' && p.hedgeGroup) || undefined,
        });
      },
    },
    {
      name: 'invoices', readOnly: true, input: { include_paid: z.boolean().optional().describe('Also list the 12 most recently paid invoices, with how late each was paid') },
      description: 'Open invoices (overdue first, with days late, whether past the grace period and when default starts), disputed ones and totals.',
      run: async (a) => {
        const open = view.invoices.filter((i) => i.paidCents < i.amountCents);
        const overdue = overdueInvoices(view, today);
        const out: Record<string, unknown> = {
          today, graceDays: grace, totalOwed: $(owed(open)), totalOverdue: $(owed(overdue)), totalInDefault: $(owed(defaultedInvoices(view, today))),
          overdue: overdue.map(invoiceRow),
          notYetDue: openInvoices(view).filter((i) => i.dueOn >= today).map(invoiceRow),
          disputed: open.filter((i) => i.status === 'disputed').map(invoiceRow),
        };
        if (a.include_paid) {
          out.recentlyPaid = view.invoices.filter((i) => i.paidCents >= i.amountCents && i.paidOn).sort((x, y) => (x.paidOn! < y.paidOn! ? 1 : -1)).slice(0, 12)
            .map((i) => ({ id: i.id, amount: $(i.amountCents), dueOn: i.dueOn, paidOn: i.paidOn, paidDaysLate: daysBetween(i.dueOn, i.paidOn!) }));
        }
        return json(out);
      },
    },
    {
      name: 'payments', readOnly: true, input: {},
      description: 'Recent money from this client: bank movements (newest first) with whether each is applied, payments in transit, returned payments, how payments were applied to invoices, and recent withdrawal requests.',
      run: async () => {
        const move = (m: (typeof view.cash)[number]) => ({ ref: m.bankRef, amount: $(m.amountCents), rail: m.rail, from: m.origName, valueOn: m.valueOn, status: m.status, applied: m.matchStatus, returnCode: m.returnCode, memo: m.memo || undefined });
        const recent = [...view.cash].sort((x, y) => (x.valueOn < y.valueOn ? 1 : -1)).slice(0, 10);
        return json({
          today, recent: recent.map(move), inTransit: view.inTransit.map(move), returned: view.cash.filter((m) => m.matchStatus === 'reversed').slice(0, 5).map(move),
          applications: f.applications.slice(-10).reverse().map((a) => ({ invoice: a.invoiceId, amount: $(a.amountCents), method: a.method, reversed: a.reversed || undefined })),
          withdrawals: view.accessRequests.filter((r) => r.action === 'withdraw').slice(-5).map((r) => ({ decision: r.decision, released: $(r.allowedCents) })),
          wireInstructions: f.world.wireInstructions,
        });
      },
    },
    {
      name: 'history', readOnly: true, input: {},
      description: 'Relationship manager notes and whether they were answered, deadlines and cure state, this client\'s own past decisions (precedents), the desk\'s earlier waits, open and recent work items, and what people approved or rejected.',
      run: async () => json({
        today,
        rmNotes: view.rmNotes.map((n) => {
          const r = f.world.readings.get(n.id);
          return { id: n.id, from: n.author, text: n.text, answered: answered(view, n.id), reading: r && { intent: r.intent.replace(/_/g, ' '), summary: r.summary, claimedAmount: r.claimedAmountUsd ?? undefined, reference: r.paymentReference ?? undefined } };
        }),
        deadlines: view.deadlines.map((d) => ({ kind: d.kind.replace(/_/g, ' '), status: d.status, startedOn: d.startedOn, dueOn: d.dueOn, note: d.note })),
        ownPrecedents: view.precedents.filter((p) => p.decision).slice(-5).map((p) => ({ decidedOn: p.decidedOn, situation: p.situation, proposed: p.proposed, decision: p.decision, reason: p.overrideReason, outcome: p.outcome })),
        earlierWaits: f.waits.map((w) => ({ on: w.on, why: w.reason })),
        workItems: view.workItems.slice(-10).map((w) => ({ id: w.id, kind: w.kind.replace(/_/g, ' ').toLowerCase(), state: w.state, title: w.title, amount: w.amountCents ? $(w.amountCents) : undefined })),
        rejectedByPeople: view.rejections.slice(-3).map((r) => ({ on: r.simDate, kind: r.workItemKind, why: r.detail })),
        approvedByPeople: view.approvals.slice(-3).map((r) => ({ on: r.simDate, kind: r.workItemKind })),
        exploitFlags: f.flags.map((x) => ({ pattern: x.pattern.replace(/_/g, ' '), status: x.status, months: x.months || undefined })),
      }),
    },
    {
      name: 'similar_cases', readOnly: true, input: {},
      description: 'Past decisions people made on OTHER clients that look like this one (same exploit pattern first, then same tier, then similar overdue amount): what was proposed, what the person decided and why, and the outcome. Check this before acting.',
      run: async () => (f.similar.length
        ? json({ cases: f.similar.map((c) => ({ client: c.client, tier: c.tier, matched: c.matched, decidedOn: c.decidedOn, situation: c.situation, proposed: c.proposed, decision: c.decision, why: c.reason, outcome: c.outcome, source: c.source })) })
        : 'no similar cases on record'),
    },
  ];
}

/** "Checked payments, contract and holds." from the read tools the session called, in the order first used. */
export function checkedPhrase(called: string[]): string {
  const parts = [...new Set(called.flatMap((n) => CHECKED[n] ?? []))];
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Checked ${list}.`;
}
