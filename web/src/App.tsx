import { useState, type CSSProperties } from 'react';
import { Eye, Gauge, Inbox, Landmark, ScrollText, Users } from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { AlertBar } from './components/AlertBar';
import { SlidingPill } from './components/SlidingPill';
import { Splash } from './components/Splash';
import { SessionPill, TopBar } from './components/TopBar';
import { reasonFor } from './lib/autonomy';
import { tables } from './module_bindings';
import { AuditLog } from './screens/AuditLog';
import { BankBooks } from './screens/BankBooks';
import { ClientPortal } from './screens/ClientPortal';
import { Clients } from './screens/Clients';
import { CreditAnalyst } from './screens/credit/CreditAnalyst';
import { WorkQueue } from './screens/WorkQueue';

const SCREENS = {
  clients: { label: 'Clients', component: Clients, icon: Users },
  approvals: { label: 'Approvals', component: WorkQueue, icon: Inbox },
  credit: { label: 'Credit Analyst', component: CreditAnalyst, icon: Gauge },
  bank: { label: 'Bank', component: BankBooks, icon: Landmark },
  audit: { label: 'Audit log', component: AuditLog, icon: ScrollText },
  portal: { label: 'Client view', component: ClientPortal, icon: Eye },
} as const;

type ScreenKey = keyof typeof SCREENS;

export function App() {
  // A link like /#credit opens that screen directly.
  const [screen, setScreen] = useState<ScreenKey>(() => {
    const hash = window.location.hash.slice(1);
    return hash in SCREENS ? (hash as ScreenKey) : 'clients';
  });
  const [items, itemsReady] = useTable(tables.workItem);
  const [clients, clientsReady] = useTable(tables.client);
  // The page waits under the loader; its reveal animations start when the loader leaves.
  const [booting, setBooting] = useState(true);
  // Same count as the Approvals tab: open items the agent asked a person about.
  const waiting = items.filter(
    (w) =>
      (w.state === 'PROPOSED' || w.state === 'NEEDS_INFO') &&
      reasonFor(
        w,
        clients.find((c) => c.id === w.clientId),
      ),
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
              {(() => {
                const Icon = SCREENS[key].icon;
                return <Icon size={15} aria-hidden />;
              })()}
              {SCREENS[key].label}
              {key === 'approvals' && waiting > 0 && <span className="pip">{waiting}</span>}
            </button>
          ))}
        </nav>
        <SessionPill />
      </header>
      <TopBar />
      <AlertBar onOpen={() => setScreen('bank')} />
      {/* Keyed so each screen staggers in again when you switch to it. */}
      <main key={screen} className="reveal-stack">
        <Screen />
      </main>
    </div>
  );
}
