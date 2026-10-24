/**
 * Checks the credit analyst's output in the shared database against the answer
 * key (docs/credit.md). Run after `pnpm demo:reset && pnpm sync` and one agent
 * cycle (`pnpm agents`). Usage: pnpm credit:verify
 */
import { tables } from '../module_bindings';
import { connectStdb } from '../lib/stdb';

/** Expected outcome per client on the demo morning: a new tier, a review, or nothing. */
const KEY: Record<string, number | 'review' | 'stay'> = {
  'ORG-90101': 'review', 'ORG-90107': 'stay', 'ORG-90118': 'stay', 'ORG-90142': 1, 'ORG-90164': 1,
  'ORG-90176': 'stay', 'ORG-90229': 3, 'ORG-90233': 'stay', 'ORG-90244': 'stay', 'ORG-90251': 'stay',
  'ORG-90287': 'stay', 'ORG-90302': 'stay', 'ORG-90355': 'stay', 'ORG-90366': 'stay', 'ORG-90378': 2,
  'ORG-90391': 2, 'ORG-90399': 2, 'ORG-90412': 'stay', 'ORG-90431': 'stay', 'ORG-90455': 'stay',
  'ORG-90463': 'stay', 'ORG-90518': 5, 'ORG-90612': 'stay', 'ORG-90677': 'stay', 'ORG-90689': 2,
  'ORG-90731': 'stay', 'ORG-90744': 5, 'ORG-90758': 'stay', 'ORG-90802': 'stay', 'ORG-90816': 'stay',
};
const FLAGS = [
  'quarter_end:ORG-90101', 'recent_late:ORG-90412', 'dispute_delay:ORG-90518', 'restriction_eve:ORG-90677',
  'partial_reset:ORG-90744', 'pays_restricted_only:ORG-90758',
];
const PATTERNS = new Set(FLAGS.map((f) => f.split(':')[0]));
const FIELDSTONE = 'ORG-90229';
const SALTMARSH = 'ORG-90612';
const OPEN = new Set(['PROPOSED', 'NEEDS_INFO']);

const { conn } = await connectStdb();
await new Promise<void>((resolve) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.client, tables.creditProfile, tables.exploitFlag, tables.workItem, tables.invoice, tables.clock,
  ]),
);
const db = conn.db;
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const clients = [...db.client.iter()].sort((a, b) => a.id.localeCompare(b.id));
const profiles = new Map([...db.creditProfile.iter()].map((p) => [p.clientId, p]));
const flags = [...db.exploitFlag.iter()].filter((f) => PATTERNS.has(f.pattern));
const reviews = [...db.workItem.iter()].filter((w) => w.kind === 'CREDIT_REVIEW' && OPEN.has(w.state));
console.log(`Credit analyst on ${db.clock.id.find(1)?.simDate ?? '?'}\n`);

check(profiles.size === 30 && clients.every((c) => profiles.has(c.id)), `30 credit_profile rows (${profiles.size})`);

// Fieldstone's slide shows once payment checking has applied its 2026-03-02 lump sum.
const lumpApplied = [...db.invoice.iter()]
  .filter((i) => i.clientId === FIELDSTONE && i.period < '2026-02')
  .every((i) => i.status === 'paid');
// Saltmarsh paid January on Feb 19 (billing never applied it); once payment checking has, it earns 4 -> 3.
const saltmarshJan = [...db.invoice.iter()].filter((i) => i.clientId === SALTMARSH && i.period === '2026-01');
if (saltmarshJan.length && saltmarshJan.every((i) => i.status === 'paid')) KEY[SALTMARSH] = 3;
const expectedFlags = new Set([...FLAGS, ...(lumpApplied ? [`recent_late:${FIELDSTONE}`] : [])]);
const gotFlags = new Set(flags.map((f) => f.id));
const missing = [...expectedFlags].filter((f) => !gotFlags.has(f));
const extra = [...gotFlags].filter((f) => !expectedFlags.has(f));
check(!missing.length && !extra.length, `${expectedFlags.size} exploit flags from the agent`,
  `missing ${missing.join(' ') || '-'}; unexpected ${extra.join(' ') || '-'}`);
check(flags.filter((f) => f.id.endsWith(':ORG-90101')).every((f) => f.status === 'watch'), 'Strategic client flagged as watch');

const expectedSubject = (clientId: string, tier: number) => {
  const k = KEY[clientId];
  return k === 'stay' ? undefined : k === 'review' ? `review:${clientId}` : `tier:${clientId}:${tier}->${k}`;
};
const wanted = clients.map((c) => expectedSubject(c.id, c.tier)).filter((s): s is string => !!s);
const subjects = reviews.map((w) => w.subjectId);
const dupes = subjects.filter((s, i) => subjects.indexOf(s) !== i);
check(wanted.every((s) => subjects.includes(s)) && subjects.length === wanted.length && !dupes.length,
  `${wanted.length} open CREDIT_REVIEW items, one per change or review (${subjects.length})`,
  `missing ${wanted.filter((s) => !subjects.includes(s)).join(' ') || '-'}; unexpected ${subjects.filter((s) => !wanted.includes(s)).join(' ') || '-'}`);
check(reviews.every((w) => w.requiredRole === 'CONTROLLER'), 'Every review needs a controller');
check(!reviews.some((w) => w.subjectId.startsWith('tier:') && clients.find((c) => c.id === w.clientId)?.strategic),
  'No tier change proposed for a strategic client');

console.log('\nClient                    Tier  Proposed  Rel  Val  Coverage  Settle      Flags');
for (const c of clients) {
  const p = profiles.get(c.id);
  const review = reviews.find((w) => w.clientId === c.id);
  const proposed = !review ? '—' : review.subjectId.startsWith('review:') ? 'review' : review.subjectId.split('->')[1];
  const own = flags.filter((f) => f.clientId === c.id).map((f) => f.pattern).join(', ');
  console.log(
    `${c.name.padEnd(25)} ${String(c.tier).padEnd(5)} ${proposed!.padEnd(9)} ${String(p?.reliabilityScore ?? '-').padStart(3)}  `
    + `${String(p?.valueScore ?? '-').padStart(3)}  ${(p ? p.coverageRatio.toFixed(2) : '-').padStart(8)}  ${(p?.expectedSettleOn ?? '-').padEnd(10)}  ${own}`,
  );
}

conn.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
