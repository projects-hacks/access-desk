import { useState } from 'react';
import { Loader2, Zap, X } from 'lucide-react';
import { config } from '../lib/config';
import { demo } from '../lib/demo';

/**
 * Presenter controls for a live demo. Each scenario makes one real event happen (a wire through
 * Nessie, an RM's note, a withdrawal) to a client that fits it right now. What follows is the desk
 * responding on its own: nothing after the event is scripted.
 */
const SCENARIOS: { kind: string; label: string; shows: string }[] = [
  { kind: 'pay', label: 'Client pays', shows: 'A restricted client pays; access comes back on its own' },
  { kind: 'parent', label: 'Paid from a parent company', shows: 'An unmatched wire, then the RM says they already paid' },
  { kind: 'holdOff', label: 'RM asks to hold off', shows: 'An exception request goes to the controller' },
  { kind: 'acquisition', label: 'RM reports an acquisition', shows: 'Sage investigates, then asks the controller' },
  { kind: 'shortWire', label: 'Short international wire', shows: 'A SWIFT wire $25 short; the fee is written off' },
  { kind: 'duplicate', label: 'Duplicate wire', shows: 'The same wire twice; refunded through Nessie' },
  { kind: 'cureWithdrawal', label: 'Withdrawal during cure period', shows: 'Only what is not owed is released' },
];

type Result = { tone: 'good' | 'bad'; title: string; text: string };

export function ScenarioMenu({ onTriggered }: { onTriggered: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<Result>();
  if (!config.demoKey) return null;

  async function run(kind: string, label: string) {
    setBusy(kind);
    setResult(undefined);
    try {
      const r = await demo<{ client: string; happened: string; watch: string }>('scenario', { kind });
      setResult({ tone: 'good', title: `${label} · ${r.client}`, text: `${r.happened} ${r.watch}` });
      onTriggered();
    } catch (e) {
      setResult({ tone: 'bad', title: label, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="scn">
      {open && (
        <div className="scn-card" role="dialog" aria-label="Demo scenarios">
          <div className="scn-head">
            <strong>Scenarios</strong>
            <button className="scn-x" onClick={() => setOpen(false)} aria-label="Close scenarios"><X size={15} /></button>
          </div>
          <p className="scn-note">Each one is a real event. The desk responds on its own.</p>
          <ul className="scn-list">
            {SCENARIOS.map((s) => (
              <li key={s.kind}>
                <button disabled={!!busy} onClick={() => run(s.kind, s.label)}>
                  <span className="scn-label">{s.label}</span>
                  <span className="scn-shows">{s.shows}</span>
                  {busy === s.kind && <Loader2 size={14} className="scn-spin" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
          {result && (
            <div className={`scn-result ${result.tone}`} role="status">
              <strong>{result.title}</strong>
              <span>{result.text}</span>
            </div>
          )}
        </div>
      )}
      <button className="scn-fab" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Zap size={14} aria-hidden /> Scenarios
      </button>
    </div>
  );
}
