import { t } from 'spacetimedb/server';
import { runTieOut } from '../books/tieout';
import { requireRole } from '../context';
import { spacetimedb } from '../schema';

/** Reconcile now. Sync calls this after each pass; a controller can run it any time. */
export const tieOut = spacetimedb.reducer({ trigger: t.string() }, (ctx, { trigger }) => {
  requireRole(ctx, ['SYNC', 'GATEWAY', 'CONTROLLER', 'ADMIN']);
  runTieOut(ctx, trigger);
});
