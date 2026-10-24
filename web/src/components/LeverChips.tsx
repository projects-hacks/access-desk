import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';

export const LEVERS = [
  { key: 'withdrawals', short: 'W', name: 'Withdrawals' },
  { key: 'trading', short: 'T', name: 'Trading' },
  { key: 'api', short: 'A', name: 'API' },
  { key: 'financing', short: 'F', name: 'Financing' },
] as const;

export type LeverState = 'active' | 'limited' | 'off' | 'not_used';

/** One chip per lever (W/T/A/F), coloured by state; hover shows the detail. */
export function LeverChips({
  states,
  details = {},
  changed,
}: {
  states: Partial<Record<string, string>>;
  details?: Partial<Record<string, string>>;
  /** Lever to outline, e.g. the one a proposal would change. */
  changed?: string;
}) {
  return (
    <span className="chips">
      {LEVERS.map((l) => {
        const state = states[l.key] ?? 'not_used';
        const title = `${l.name}: ${state.replace('_', ' ')}${details[l.key] ? ` · ${details[l.key]}` : ''}`;
        return (
          <span
            key={l.key}
            className={`chip ${state}${changed === l.key ? ' changed' : ''}`}
            title={title}
            aria-label={title}
          >
            {l.short}
          </span>
        );
      })}
    </span>
  );
}

/** Live lever states for every client: `byClient[clientId][lever]`. */
export function useLevers() {
  const [rows] = useTable(tables.accessLever);
  const states: Record<string, Record<string, string>> = {};
  const details: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    (states[r.clientId] ??= {})[r.lever] = r.state;
    (details[r.clientId] ??= {})[r.lever] = r.detail;
  }
  return { states, details };
}

/** Where a restriction step leaves the lever. */
export function stateAfter(kind: string, step: string | undefined): LeverState {
  if (kind === 'RESTORE') return 'active';
  if (step && /FREEZE|OFF|DISABLE/.test(step)) return 'off';
  return 'limited';
}
