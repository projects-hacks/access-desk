import { useEffect, useState, type CSSProperties } from 'react';
import { Eye, Gauge, Inbox, Landmark, ScrollText, Users } from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { AgentsPanel } from './components/AgentsPanel';
import { AlertBar } from './components/AlertBar';
import { SlidingPill } from './components/SlidingPill';
import { Splash } from './components/Splash';
import { PlatformDate, SessionPill, TopBar } from './components/TopBar';
import { reasonFor } from './lib/autonomy';
import { tables } from './module_bindings';
import { AuditLog } from './screens/AuditLog';
import { BankBooks } from './screens/BankBooks';
import { ClientPortal } from './screens/ClientPortal';
import { Clients } from './screens/Clients';
import { CreditAnalyst } from './screens/credit/CreditAnalyst';
import { WorkQueue, type Focus } from './screens/WorkQueue';

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
  // "Open in approvals" from the agents panel: which client's request to open once the screen is up.
  const [focus, setFocus] = useState<Focus>();
  // "Review" anywhere else (e.g. a client's side panel) asks for the same thing.
  useEffect(() => {
    const open = (e: Event) => {
      const { clientId, workItemId } = (e as CustomEvent<{ clientId: string; workItemId?: bigint }>).detail;
      setFocus({ clientId, workItemId, nonce: Date.now() });
      setScreen('approvals');
    };
    window.addEventListener('neo:open-approval', open);
    return () => window.removeEventListener('neo:open-approval', open);
  }, []);
  // Docked beside the page on a wide screen; on a phone it starts as a pill so the page stays in view.
  const [agentsOpen, setAgentsOpen] = useState(() => window.matchMedia('(min-width: 900px)').matches);
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
    <div className={`app ${booting ? 'booting' : ''} ${agentsOpen ? 'agents-open' : ''}`}>
      <Splash ready={itemsReady && clientsReady} onLeave={() => setBooting(false)} />
      <header className="appbar reveal" style={{ '--d': '0ms' } as CSSProperties}>
        <div className="brand">Neo</div>
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
        <PlatformDate />
        <SessionPill />
      </header>
      <TopBar />
      <AlertBar onOpen={() => setScreen('bank')} />
      {/* Keyed so each screen staggers in again when you switch to it. */}
      <main key={screen} className="reveal-stack">
        {screen === 'approvals' ? <WorkQueue focus={focus} /> : <Screen />}
      </main>
      <AgentsPanel
        open={agentsOpen}
        onToggle={() => setAgentsOpen(!agentsOpen)}
        onOpenApprovals={(need) => {
          setFocus({ clientId: need.clientId, workItemId: need.workItemId, nonce: Date.now() });
          setScreen('approvals');
          // On a phone the sheet covers the screen it just opened.
          if (!window.matchMedia('(min-width: 900px)').matches) setAgentsOpen(false);
        }}
        onOpenAudit={() => {
          setScreen('audit');
          if (!window.matchMedia('(min-width: 900px)').matches) setAgentsOpen(false);
        }}
      />
    </div>
  );
}
