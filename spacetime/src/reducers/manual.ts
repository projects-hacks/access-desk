import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole, type Ctx } from '../context';
import { needsHuman } from '../autonomy';
import { PERMISSIONS, isPermission, leverSummary, permissionNeedsHuman, type PermissionKey } from '../permissions';
import { queueCommand } from '../payments/gateway';
import { spacetimedb } from '../schema';
import { executeApproved } from './actions';

/**
 * A controller moves a client to another tier from the console. Same CREDIT_REVIEW
 * path as the credit agent: tier 3 to 5 moves apply at once; tier 1 and 2, strategic
 * clients and moves onto tier 5 wait for a second controller (no self-approval).
 */
export const proposeTierChange = spacetimedb.reducer(
  { clientId: t.string(), toTier: t.u8(), reasoning: t.string() },
  (ctx, { clientId, toTier, reasoning }) => {
    requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    if (toTier < 1 || toTier > 5) throw new SenderError('tier must be 1 to 5');
    if (toTier === c.tier) throw new SenderError(`${c.name} is already tier ${c.tier}`);
    if (!reasoning.trim()) throw new SenderError('give the reasoning for the change');

    const proposal = { action: 'tier_change', from_tier: c.tier, to_tier: toTier, decided_by: 'controller' };
    const reason = needsHuman({ kind: 'CREDIT_REVIEW', tier: c.tier, strategic: c.strategic, confidence: 1, proposal });
    const auto = reason === undefined;
    const title = `Move ${c.name} from tier ${c.tier} to tier ${toTier}`;
    const item = ctx.db.workItem.insert({
      id: 0n, kind: 'CREDIT_REVIEW', clientId, subjectId: clientId, state: auto ? 'APPROVED' : 'PROPOSED', title,
      amountCents: 0n, proposalJson: JSON.stringify(proposal), reasoning: reasoning.trim(), policyRef: 'manual',
      clausesCited: [], boundariesJson: '[]', confidence: 1, autoApplied: auto, requiredRole: 'CONTROLLER',
      proposedBy: ctx.sender, revision: 1, revisedFrom: undefined, expiresOn: undefined, createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
    audit(ctx, {
      action: auto ? 'AUTO_APPLIED' : 'PROPOSE', subjectType: 'work_item', subjectId: String(item.id), clientId, workItemId: item.id,
      fromState: 'NEW', toState: item.state, detail: `${title} · ${auto ? 'applied: tier 3 to 5 move' : `needs a second controller: ${reason}`}`,
      policyRef: 'manual',
    });
    if (auto) executeApproved(ctx, item.id);
  },
);

const PermissionChange = t.object('PermissionChange', { key: t.string(), enabled: t.bool() });

/**
 * A controller switches fine-grained permissions (buy, sell, crypto withdrawals...) from the
 * console. Giving access back and routine cuts for tier 3 to 5 apply at once; tier 1 and 2,
 * strategic clients and turning off sell wait for a second controller.
 */
export const proposePermissionChange = spacetimedb.reducer(
  { clientId: t.string(), changes: t.array(PermissionChange), reasoning: t.string() },
  (ctx, { clientId, changes, reasoning }) => {
    requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    if (!changes.length) throw new SenderError('nothing to change');
    if (!reasoning.trim()) throw new SenderError('give the reasoning for the change');
    for (const ch of changes) {
      if (!isPermission(ch.key)) throw new SenderError(`unknown permission ${ch.key}`);
      const lever = PERMISSIONS.find((p) => p.key === ch.key)!.lever;
      const row = ctx.db.accessLever.id.find(`${clientId}:${lever}`);
      if (!row || row.state === 'not_used') throw new SenderError(`${lever} is not part of ${c.name}'s contract`);
    }

    const reason = permissionNeedsHuman({ tier: c.tier, strategic: c.strategic, changes });
    const auto = reason === undefined;
    const name = (k: string) => PERMISSIONS.find((p) => p.key === k)!.name;
    const title = `${c.name}: ${changes.map((ch) => `${name(ch.key)} ${ch.enabled ? 'on' : 'off'}`).join(', ')}`;
    const item = ctx.db.workItem.insert({
      id: 0n, kind: 'PERMISSION_CHANGE', clientId, subjectId: clientId, state: auto ? 'APPROVED' : 'PROPOSED', title,
      amountCents: 0n, proposalJson: JSON.stringify({ changes }), reasoning: reasoning.trim(), policyRef: 'manual',
      clausesCited: [], boundariesJson: '[]', confidence: 1, autoApplied: auto, requiredRole: 'CONTROLLER',
      proposedBy: ctx.sender, revision: 1, revisedFrom: undefined, expiresOn: undefined, createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
    audit(ctx, {
      action: auto ? 'AUTO_APPLIED' : 'PROPOSE', subjectType: 'work_item', subjectId: String(item.id), clientId, workItemId: item.id,
      fromState: 'NEW', toState: item.state, detail: `${title} · ${auto ? 'applied' : `needs a second controller: ${reason}`}`,
      policyRef: 'manual',
    });
    if (auto) executeApproved(ctx, item.id);
  },
);

/** Approved PERMISSION_CHANGE: store the permissions, then bring each touched lever's summary in line. */
export function applyPermissionChange(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return;
  const { changes } = JSON.parse(item.proposalJson) as { changes: { key: PermissionKey; enabled: boolean }[] };
  for (const ch of changes) {
    const id = `${item.clientId}:${ch.key}`;
    const row = { id, clientId: item.clientId, key: ch.key, enabled: ch.enabled, workItemId: item.id, updatedAt: ctx.timestamp };
    if (ctx.db.permission.id.find(id)) ctx.db.permission.id.update(row);
    else ctx.db.permission.insert(row);
  }

  const levers = new Set(changes.map((ch) => PERMISSIONS.find((p) => p.key === ch.key)!.lever));
  const leverRow = (lever: string) => ctx.db.accessLever.id.find(`${item.clientId}:${lever}`);
  // A permission with no row follows its lever as it was before this change.
  const enabled = (k: PermissionKey) => {
    const row = ctx.db.permission.id.find(`${item.clientId}:${k}`);
    return row ? row.enabled : leverRow(PERMISSIONS.find((p) => p.key === k)!.lever)?.state === 'active';
  };
  const held = [...ctx.db.hold.clientId.filter(item.clientId)].some((h) => h.status === 'active');
  for (const lever of levers) {
    const row = leverRow(lever);
    if (!row) continue;
    const summary = leverSummary(lever, enabled);
    // An amount hold stays in force until payment releases it.
    const next = lever === 'withdrawals' && held && summary.state === 'active' ? { state: 'limited', detail: row.detail } : summary;
    ctx.db.accessLever.id.update({ ...row, state: next.state, detail: next.detail, workItemId: item.id });
    queueCommand(ctx, `SET_LEVER:${item.id}:${lever}`, { type: 'SET_LEVER', clientId: item.clientId, lever, state: next.state, detail: next.detail }, item.id);
    audit(ctx, {
      action: 'LEVER_SET', subjectType: 'access_lever', subjectId: row.id, clientId: item.clientId, workItemId: item.id,
      fromState: row.state, toState: next.state, detail: next.detail, policyRef: item.policyRef,
    });
  }

  const c = ctx.db.client.id.find(item.clientId);
  const limited = [...ctx.db.accessLever.clientId.filter(item.clientId)].some((l) => l.state === 'limited' || l.state === 'off');
  if (c && c.status !== 'held' && c.status !== 'prepay') ctx.db.client.id.update({ ...c, status: limited ? 'restricted' : 'active' });
}
