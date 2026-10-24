import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { actor, isNews } from '../lib/bank';
import { shortDate } from '../lib/clients';
import { label } from '../lib/format';
import { BankBooks } from './BankBooks';

const TABS = { bank: 'Bank & books', audit: 'Audit log' } as const;
type Tab = keyof typeof TABS;

/** What happened: money through the bank and the books, and every decision in the audit log. */
export function AuditLog() {
  const [tab, setTab] = useState<Tab>('bank');
  return (
    <section>
      <div className="screen-head">
        <div>
          <h2>Activity</h2>
          <p className="muted">Money in and out, the books behind it, and every decision with who made it.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {TABS[k]}
          </button>
        ))}
      </div>
      {tab === 'bank' ? <BankBooks /> : <Decisions />}
    </section>
  );
}

/** Every transition, allowed or denied, with the policy behind it. */
function Decisions() {
  const [audit] = useTable(tables.auditEvent);
  const events = useMemo(
    () => audit.filter(isNews).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 150),
    [audit],
  );
  return events.length === 0 ? (
    <div className="empty">Nothing yet.</div>
  ) : (
    <ol className="timeline">
      {events.map((e) => (
        <li key={String(e.id)} className={e.allowed ? '' : 'denied'}>
          <span className="eyebrow">
            {shortDate(e.simDate)} · {actor(e)}
            {e.clientId && ` · ${e.clientId}`}
            {e.policyRef && ` · ${e.policyRef}`}
          </span>
          <span>
            {label(e.action)}
            {!e.allowed && ' · denied'}
          </span>
          {e.detail && <span className="muted">{e.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
