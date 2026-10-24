import type { NessieApi, NessieTransaction } from './client';
import type { SeedMap } from './seed-map';
import type { SeedPlan } from './seed-plan';

/**
 * Puts the bank back exactly as seeded: restores seeded statuses and dates,
 * deletes anything created since (demo wires, refunds, injected payments).
 */
export async function resetBank(api: NessieApi, map: SeedMap, plan: SeedPlan): Promise<{ restored: number; deleted: number }> {
  const seededTx = new Map(Object.entries(map.transactions).map(([key, id]) => [id, key]));
  const seededBills = new Map(Object.entries(map.bills).map(([key, id]) => [id, key]));
  const txPlan = new Map(plan.transactions.map((t) => [t.key, t]));
  const billPlan = new Map(plan.bills.map((b) => [b.key, b]));
  let restored = 0;
  let deleted = 0;

  await Promise.all(
    Object.values(map.accounts).map(async (acct) => {
      const [deposits, withdrawals, bills] = await Promise.all([api.listDeposits(acct.id), api.listWithdrawals(acct.id), api.listBills(acct.id)]);
      const check = async (t: NessieTransaction, kind: 'deposit' | 'withdrawal') => {
        const key = seededTx.get(t._id);
        const planned = key ? txPlan.get(key) : undefined;
        if (!planned) {
          await (kind === 'deposit' ? api.deleteDeposit(t._id) : api.deleteWithdrawal(t._id));
          deleted++;
        } else if (t.status !== planned.status || t.transaction_date !== planned.transaction_date) {
          const body = { status: planned.status, transaction_date: planned.transaction_date };
          await (kind === 'deposit' ? api.updateDeposit(t._id, body) : api.updateWithdrawal(t._id, body));
          restored++;
        }
      };
      for (const t of deposits) await check(t, 'deposit');
      for (const t of withdrawals) await check(t, 'withdrawal');
      for (const b of bills) {
        const key = seededBills.get(b._id);
        const planned = key ? billPlan.get(key) : undefined;
        if (!planned) {
          await api.deleteBill(b._id);
          deleted++;
        } else if (b.status !== planned.status) {
          await api.updateBill(b._id, { status: planned.status });
          restored++;
        }
      }
    }),
  );
  return { restored, deleted };
}

/** Posts a pending wire on both sides, as the bank would. Returns false if it wasn't pending. */
export async function settleWire(api: NessieApi, map: SeedMap, plan: SeedPlan, movementId: string): Promise<boolean> {
  let settled = false;
  for (const side of ['platform', 'counterparty'] as const) {
    const t = plan.transactions.find((x) => x.movementId === movementId && x.side === side);
    const id = map.transactions[`${movementId}:${side}`];
    if (!t || !id) continue;
    await (t.type === 'deposit' ? api.updateDeposit(id, { status: 'completed' }) : api.updateWithdrawal(id, { status: 'completed' }));
    settled = true;
  }
  return settled;
}
