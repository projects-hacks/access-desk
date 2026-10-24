import type { Ctx } from '../context';

type CashMovementRow = NonNullable<ReturnType<Ctx['db']['cashMovement']['id']['find']>>;

/**
 * Payment checking entry point, called in the same transaction as the cash
 * being recorded. Matching rules come next (see docs/schema.md).
 */
export function onCashMovement(_ctx: Ctx, _movement: CashMovementRow, _previous: CashMovementRow | undefined) {
  // TODO: parse refs/payer, resolve client via payer_identity, apply to invoices, release holds.
}
