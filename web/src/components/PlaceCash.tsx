import { useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { simDay } from '../lib/format';
import { useSession } from '../lib/session';
import { reducers, tables } from '../module_bindings';
import type { CashMovement } from '../module_bindings/types';
import { Select } from './Select';

const PEOPLE = ['CONTROLLER', 'ACCOUNTANT', 'ADMIN'];

/**
 * Money nobody could identify: a person says whose it is, or sends it back. Crypto cannot be sent
 * back from the bank, so it is kept as unclaimed cash instead. Iris does the same on her own once
 * the return-by date passes.
 */
export function PlaceCash({ m }: { m: CashMovement }) {
  const session = useSession();
  const [clients] = useTable(tables.client);
  const [deadlines] = useTable(tables.deadline);
  const claim = useReducer(reducers.claimCash);
  const giveBack = useReducer(reducers.returnCash);
  const keep = useReducer(reducers.keepUnclaimed);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const crypto = m.rail === 'USDC' || m.platformAccount === 'wallet';
  const due = deadlines.find((d) => d.kind === 'return_by' && d.note === m.id && d.status === 'open')?.dueOn;
  const canAct = !!session.role && PEOPLE.includes(session.role);
  const options = [{ value: '', label: 'Who sent this?' }, ...[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name }))];

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await call();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^.*?:\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="place-cash">
      <p className="muted small">
        Nobody on file sent this, so it is held as unapplied cash.
        {due && ` ${crypto ? 'It is kept as unclaimed cash' : 'It goes back to the sender'} on ${simDay(due)} unless someone claims it.`}
      </p>
      {canAct ? (
        <div className="place-cash-actions">
          <Select label="Client" value={clientId} options={options} onChange={setClientId} />
          <button className="btn primary" disabled={!clientId || busy} onClick={() => run(() => claim({ movementId: m.id, clientId, reasoning: '' }))}>
            Match to client
          </button>
          {crypto ? (
            <button className="btn" disabled={busy} onClick={() => run(() => keep({ movementId: m.id, reason: 'A person kept it as unclaimed cash.' }))}>
              Keep as unclaimed
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run(() => giveBack({ movementId: m.id, reason: 'A person sent it back.' }))}>
              Return to sender
            </button>
          )}
        </div>
      ) : (
        <p className="muted small">A controller or accountant can match it or send it back.</p>
      )}
      {error && <p className="place-cash-error">{error}</p>}
    </div>
  );
}
