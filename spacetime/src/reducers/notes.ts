import { SenderError, t } from 'spacetimedb/server';
import { route } from '../agents';
import { audit, requireRole } from '../context';
import { spacetimedb } from '../schema';

/**
 * A relationship manager speaks for the client ("they already paid", "don't
 * freeze them"). The note is evidence for the agents; it never changes access
 * by itself.
 */
export const addRmNote = spacetimedb.reducer(
  { clientId: t.string(), author: t.string(), text: t.string(), workItemId: t.u64().optional() },
  (ctx, { clientId, author, text, workItemId }) => {
    requireRole(ctx, ['RELATIONSHIP_MANAGER', 'CONTROLLER', 'DEMO', 'ADMIN']);
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    if (!text.trim()) throw new SenderError('empty note');
    if (workItemId !== undefined && ctx.db.workItem.id.find(workItemId)?.clientId !== clientId) {
      throw new SenderError(`work item ${workItemId} is not ${c.name}'s`);
    }
    const note = ctx.db.rmNote.insert({
      id: 0n, clientId, workItemId, author: author.trim() || c.relationshipManager, text: text.trim(), at: ctx.timestamp,
    });
    audit(ctx, {
      action: 'RM_NOTE', subjectType: 'rm_note', subjectId: String(note.id), clientId, workItemId,
      detail: `${note.author}: ${note.text}`,
    });
    route(ctx, 'rm_note', clientId, `RM note from ${note.author}`);
  },
);

const Step = t.object('InvestigationStepInput', { tool: t.string(), summary: t.string(), status: t.string() });

/** What an agent looked at before proposing a novel case, in order. Replaces any earlier record for the item. */
export const recordInvestigation = spacetimedb.reducer(
  { workItemId: t.u64(), steps: t.array(Step) },
  (ctx, { workItemId, steps }) => {
    requireRole(ctx, ['AGENT', 'ADMIN']);
    const item = ctx.db.workItem.id.find(workItemId);
    if (!item) throw new SenderError(`work item ${workItemId} not found`);
    for (const old of [...ctx.db.investigationStep.workItemId.filter(workItemId)]) ctx.db.investigationStep.id.delete(old.id);
    steps.forEach((s, i) => ctx.db.investigationStep.insert({ id: 0n, workItemId, seq: i + 1, tool: s.tool, summary: s.summary, status: s.status }));
    audit(ctx, {
      action: 'INVESTIGATED', subjectType: 'work_item', subjectId: String(workItemId), clientId: item.clientId, workItemId,
      detail: steps.map((s) => s.tool).join(' → '),
    });
  },
);
