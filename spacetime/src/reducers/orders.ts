import { SenderError, t } from 'spacetimedb/server';
import { step } from '../agents';
import { actorOf, audit, requireRole, type Ctx } from '../context';
import { queueCommand } from '../payments/gateway';
import { formatUsd } from '../payments/match';
import { spacetimedb } from '../schema';

const ASSETS: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum' };
/** Larger orders go to the OTC desk, not the order book. */
const MAX_ORDER_CENTS = 100_000_000n;

/**
 * A client buys or sells at the live price. Trading permission and cash are checked here, in
 * the transaction, against the same rows the agents restrict: a client in default who tries to
 * buy is refused by the database, not by the screen. Refusals commit (with the reason) so the
 * client and the desk both see them; accepted orders fill through the gateway.
 */
export const placeOrder = spacetimedb.reducer(
  { clientId: t.string(), side: t.string(), asset: t.string(), amountCents: t.i64() },
  (ctx, { clientId, side, asset, amountCents }) => {
    const role = requireRole(ctx, ['CLIENT', 'DEMO', 'CONTROLLER', 'ADMIN']);
    if (role === 'CLIENT' && actorOf(ctx)?.clientId !== clientId) throw new SenderError('clients can only trade on their own account');
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    if (side !== 'buy' && side !== 'sell') throw new SenderError('side must be buy or sell');
    if (!ASSETS[asset]) throw new SenderError(`${asset} is not traded here`);
    if (amountCents <= 0n || amountCents > MAX_ORDER_CENTS) throw new SenderError(`orders are between $0.01 and ${formatUsd(MAX_ORDER_CENTS)}`);
    const price = ctx.db.assetPrice.asset.find(asset)?.priceCents;
    if (!price) throw new SenderError(`no price for ${asset}`);
    const quantity = Number(amountCents) / Number(price);

    const asked = `${c.name} asked to ${side} ${formatUsd(amountCents)} of ${ASSETS[asset]}.`;
    const refusal = tradingRefusal(ctx, clientId, side) ?? fundsRefusal(ctx, clientId, side, asset, amountCents, quantity);
    const order = ctx.db.tradeOrder.insert({
      id: 0n, clientId, side, asset, amountCents, quantity, priceCents: price, status: refusal ? 'refused' : 'queued', reason: refusal?.text ?? '', at: ctx.timestamp,
    });
    audit(ctx, {
      action: refusal ? 'ORDER_REFUSED' : 'ORDER_PLACED', subjectType: 'trade_order', subjectId: String(order.id), clientId,
      toState: order.status, allowed: !refusal, detail: refusal ? `${asked} ${refusal.text}` : asked,
    });
    step(ctx, { clientId, actor: 'platform', text: asked, opens: asked, checks: refusal ? [] : [{ ok: true, label: 'trading open' }, { ok: true, label: side === 'buy' ? 'cash available' : 'holding covers it' }] });
    if (refusal) {
      step(ctx, { clientId, actor: 'guardrail', text: `Refused. ${refusal.text}`, checks: [{ ok: false, label: refusal.check }] });
      return;
    }
    queueCommand(ctx, `TRADE:${order.id}`, { type: 'TRADE', clientId, orderId: String(order.id), side, asset, quantity, amountCents });
  },
);

/** Why trading is closed for this side, from the fine permissions if any, else the trading lever. */
function tradingRefusal(ctx: Ctx, clientId: string, side: string) {
  const fine = [...ctx.db.permission.clientId.filter(clientId)].find((p) => p.key === side);
  if (fine) return fine.enabled ? undefined : { text: `${side === 'buy' ? 'Buying' : 'Selling'} is switched off on this account.`, check: `${side} permission off` };
  const lever = ctx.db.accessLever.id.find(`${clientId}:trading`);
  if (!lever || lever.state === 'not_used') return { text: 'This account has no trading.', check: 'no trading product' };
  if (lever.state === 'off') return { text: 'Trading is frozen on this account.', check: 'trading frozen' };
  // No new positions / close-only stop buying; selling to reduce stays open.
  if (lever.state === 'limited' && side === 'buy' && !/OTC/i.test(lever.detail)) {
    return { text: 'New positions are paused until the overdue balance is paid; selling stays open.', check: lever.detail.toLowerCase() };
  }
  return undefined;
}

/** Buying needs unheld USD custody cash; selling needs the asset. */
function fundsRefusal(ctx: Ctx, clientId: string, side: string, asset: string, amountCents: bigint, quantity: number) {
  if (side === 'buy') {
    const usd = ctx.db.custodyHolding.id.find(`${clientId}:USD`)?.valueCents ?? 0n;
    const held = [...ctx.db.hold.clientId.filter(clientId)].filter((h) => h.status === 'active').reduce((s, h) => s + h.amountCents, 0n);
    const free = usd - held;
    if (free < amountCents) return { text: `Only ${formatUsd(free > 0n ? free : 0n)} of cash is available${held > 0n ? ` (${formatUsd(held)} is held)` : ''}.`, check: 'not enough cash' };
    return undefined;
  }
  const have = ctx.db.custodyHolding.id.find(`${clientId}:${asset}`)?.quantity ?? 0;
  if (have < quantity) return { text: `The account holds ${have.toFixed(4)} ${asset}, less than ${quantity.toFixed(4)}.`, check: `not enough ${asset}` };
  return undefined;
}
