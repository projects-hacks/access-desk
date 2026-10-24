import type { GatewayAction } from '../domain';
import { store } from '../simulator/store';

/** Applies an authorized action to the systems of record. */
export async function execute(action: GatewayAction): Promise<void> {
  switch (action.type) {
    case 'POST_LEDGER_ENTRY':
      store.ledger.push({ ...action, at: new Date().toISOString() });
      return;
    case 'SET_RESTRICTION':
      const { clientId, product, step } = action;
      store.restrictions.set(`${clientId}:${product}`, { clientId, product, step });
      return;
    case 'LIFT_RESTRICTION':
      store.restrictions.delete(`${action.clientId}:${action.product}`);
      return;
    case 'SEND_MESSAGE':
    case 'SET_PREPAY':
      throw new Error(`${action.type} not implemented`);
  }
}
