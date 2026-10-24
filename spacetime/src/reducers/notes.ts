import { SenderError, t } from 'spacetimedb/server';
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
  },
);
