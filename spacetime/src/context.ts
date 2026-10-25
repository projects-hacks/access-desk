import { SenderError, type ReducerCtx } from 'spacetimedb/server';
import { stepFromAudit } from './agents';
import type { Role } from './roles';
import type { spacetimedb } from './schema';

export type Ctx = ReducerCtx<(typeof spacetimedb)['schemaType']>;

export function actorOf(ctx: Ctx) {
  return ctx.db.actor.identity.find(ctx.sender);
}

export function requireRole(ctx: Ctx, allowed: readonly Role[]): Role {
  const role = actorOf(ctx)?.role as Role | undefined;
  if (!role || !allowed.includes(role)) {
    throw new SenderError(`requires one of ${allowed.join(', ')}; caller is ${role ?? 'unregistered'}`);
  }
  return role;
}

export function simDate(ctx: Ctx): string {
  return ctx.db.clock.id.find(1)?.simDate ?? '';
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface AuditInput {
  action: string;
  subjectType: string;
  subjectId: string;
  clientId?: string;
  workItemId?: bigint;
  fromState?: string;
  toState?: string;
  allowed?: boolean;
  detail?: string;
  policyRef?: string;
}

/** Append an audit row. Call it in the same reducer as the change it records. */
export function audit(ctx: Ctx, e: AuditInput) {
  const who = actorOf(ctx);
  const system = ctx.sender.isEqual(ctx.databaseIdentity);
  ctx.db.auditEvent.insert({
    id: 0n,
    at: ctx.timestamp,
    simDate: simDate(ctx),
    actor: ctx.sender,
    actorRole: who?.role ?? (system ? 'SYSTEM' : 'UNREGISTERED'),
    actorName: who?.name ?? (system ? 'scheduler' : ''),
    action: e.action,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    clientId: e.clientId ?? '',
    workItemId: e.workItemId,
    fromState: e.fromState ?? '',
    toState: e.toState ?? '',
    allowed: e.allowed ?? true,
    detail: e.detail ?? '',
    policyRef: e.policyRef ?? '',
  });
  stepFromAudit(ctx, e);
}
