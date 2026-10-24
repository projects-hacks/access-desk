import { useState, type CSSProperties } from 'react';
import { useTable } from 'spacetimedb/react';
import { SlidingPill } from './components/SlidingPill';
import { Splash } from './components/Splash';
import { SessionPill, TopBar } from './components/TopBar';
import { tables } from './module_bindings';
import { AuditLog } from './screens/AuditLog';
import { ClientPortal } from './screens/ClientPortal';
import { Clients } from './screens/Clients';
import { CreditDesk } from './screens/CreditDesk';
import { WorkQueue } from './screens/WorkQueue';

const SCREENS = {
  clients: { label: 'Clients', component: Clients },
  approvals: { label: 'Approvals', component: WorkQueue },
  credit: { label: 'Credit', component: CreditDesk },
  activity: { label: 'Activity', component: AuditLog },
  portal: { label: 'Client view', component: ClientPortal },
} as const;

type ScreenKey = keyof typeof SCREENS;

export function App() {
  // A link like /#credit opens that screen directly.
  const [screen, setScreen] = useState<ScreenKey>(() => {
    const hash = window.location.hash.slice(1);
    return hash in SCREENS ? (hash as ScreenKey) : 'clients';
  });
  const [items, itemsReady] = useTable(tables.workItem);
  const [, clientsReady] = useTable(tables.client);
  // The page waits under the loader; its reveal animations start when the loader leaves.
  const [booting, setBooting] = useState(true);
  const waiting = items.filter(
    (w) => (w.state === 'PROPOSED' || w.state === 'NEEDS_INFO') && !w.autoApplied,
  ).length;
  const Screen = SCREENS[screen].component;
  return (
    <div className={`app ${booting ? 'booting' : ''}`}>
      <Splash ready={itemsReady && clientsReady} onLeave={() => setBooting(false)} />
      <header className="appbar reveal" style={{ '--d': '0ms' } as CSSProperties}>
        <div className="brand">Access Desk</div>
        <nav className="screens" aria-label="Screens">
          <SlidingPill active={screen} />
          {(Object.keys(SCREENS) as ScreenKey[]).map((key) => (
            <button
              key={key}
              className={key === screen ? 'active' : ''}
              data-active={key === screen}
              aria-current={key === screen ? 'page' : undefined}
              onClick={() => setScreen(key)}
            >
              {SCREENS[key].label}
              {key === 'approvals' && waiting > 0 && <span className="pip">{waiting}</span>}
            </button>
          ))}
        </nav>
        <SessionPill />
      </header>
      <TopBar />
      {/* Keyed so each screen staggers in again when you switch to it. */}
      <main key={screen} className="reveal-stack">
        <Screen />
      </main>
    </div>
  );
}
