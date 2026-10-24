import { useState } from 'react';
import { AuditLog } from './screens/AuditLog';
import { ClientPortal } from './screens/ClientPortal';
import { ControllerConsole } from './screens/ControllerConsole';
import { WorkQueue } from './screens/WorkQueue';

const SCREENS = {
  queue: { label: 'Work queue', component: WorkQueue },
  controller: { label: 'Controller', component: ControllerConsole },
  portal: { label: 'Client portal', component: ClientPortal },
  audit: { label: 'Audit log', component: AuditLog },
} as const;

type ScreenKey = keyof typeof SCREENS;

export function App() {
  const [screen, setScreen] = useState<ScreenKey>('queue');
  const Screen = SCREENS[screen].component;
  return (
    <div className="layout">
      <nav>
        <h1>Access Desk</h1>
        {(Object.keys(SCREENS) as ScreenKey[]).map((key) => (
          <button key={key} className={key === screen ? 'active' : ''} onClick={() => setScreen(key)}>
            {SCREENS[key].label}
          </button>
        ))}
      </nav>
      <main>
        <Screen />
      </main>
    </div>
  );
}
