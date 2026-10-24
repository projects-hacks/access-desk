/**
 * Checks the credit analyst's output in the shared database against the answer
 * key (docs/credit.md). Run after `pnpm demo:reset && pnpm sync` and one agent
 * cycle (`pnpm agents`). Usage: pnpm credit:verify
 *
 * Tier 1 and 2 clients (and strategic ones) always wait for a controller; for tier 3 to 5 regular
 * proposals apply on their own and the worst cases wait (spacetime/src/autonomy.ts).
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
/** Each client's tier on the demo morning (before any approved change). */
const START_TIER: Record<string, number> = {
  'ORG-90101': 1, 'ORG-90107': 1, 'ORG-90118': 1, 'ORG-90142': 2, 'ORG-90164': 2, 'ORG-90176': 3, 'ORG-90229': 2,
  'ORG-90233': 2, 'ORG-90244': 2, 'ORG-90251': 2, 'ORG-90287': 2, 'ORG-90302': 2, 'ORG-90355': 3, 'ORG-90366': 2,
  'ORG-90378': 3, 'ORG-90391': 3, 'ORG-90399': 3, 'ORG-90412': 3, 'ORG-90431': 3, 'ORG-90455': 4, 'ORG-90463': 3,
  'ORG-90518': 3, 'ORG-90612': 4, 'ORG-90677': 4, 'ORG-90689': 3, 'ORG-90731': 3, 'ORG-90744': 4, 'ORG-90758': 4,
  'ORG-90802': 5, 'ORG-90816': 5,
};
const FLAGS = [
  'quarter_end:ORG-90101', 'recent_late:ORG-90412', 'dispute_delay:ORG-90518', 'restriction_eve:ORG-90677',
  'partial_reset:ORG-90744', 'pays_restricted_only:ORG-90758',
];
const PATTERNS = new Set(FLAGS.map((f) => f.split(':')[0]));
const FIELDSTONE = 'ORG-90229';
const SALTMARSH = 'ORG-90612';
/** Waiting for a person, or already applied (by a controller or on its own). */
const LIVE = new Set(['PROPOSED', 'NEEDS_INFO', 'APPROVED', 'POSTED']);

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
const reviews = [...db.workItem.iter()].filter((w) => w.kind === 'CREDIT_REVIEW' && LIVE.has(w.state));
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
// With an API key Claude decides within the guardrails, so its choices may differ from the rules' key:
// rules-decided clients must match the key; Claude-decided ones must stay inside the hard limits.
const decidedBy = (w: { proposalJson: string }) => {
  try {
    return String(JSON.parse(w.proposalJson).decided_by ?? 'rules');
  } catch {
    return 'rules';
  }
};
const claudeClients = new Set([...db.workItem.iter()]
  .filter((w) => (w.kind === 'CREDIT_REVIEW' || w.kind === 'POLICY_DRAFT') && LIVE.has(w.state) && decidedBy(w) === 'claude')
  .map((w) => w.clientId));
const subjects = reviews.map((w) => w.subjectId);
const dupes = reviews.map((w) => w.clientId).filter((s, i, all) => all.indexOf(s) !== i);
const ruled = clients.filter((c) => !claudeClients.has(c.id));
const wanted = ruled.map((c) => expectedSubject(c.id, START_TIER[c.id] ?? c.tier)).filter((s): s is string => !!s);
const ruledSubjects = reviews.filter((w) => !claudeClients.has(w.clientId)).map((w) => w.subjectId);
check(wanted.every((s) => ruledSubjects.includes(s)) && ruledSubjects.length === wanted.length && !dupes.length,
  `Rules-decided clients match the key (${ruled.length} clients, ${ruledSubjects.length} reviews), one per client`,
  `missing ${wanted.filter((s) => !ruledSubjects.includes(s)).join(' ') || '-'}; unexpected ${ruledSubjects.filter((s) => !wanted.includes(s)).join(' ') || '-'}; duplicated ${dupes.join(' ') || '-'}`);
const flagged = new Set(flags.filter((f) => f.status !== 'cleared').map((f) => f.clientId));
const outOfBounds = reviews.filter((w) => claudeClients.has(w.clientId) && w.subjectId.startsWith('tier:')).filter((w) => {
  const [from, to] = (w.subjectId.split(':')[2] ?? '').split('->').map(Number);
  return !(from! >= 1 && to! >= 1 && to! <= 5 && to! - from! <= 2 && from! - to! <= 1 && !(flagged.has(w.clientId) && to! < Math.min(3, from!)));
});
check(!outOfBounds.length, `Claude-decided reviews stay inside the guardrails (${claudeClients.size} clients)`, outOfBounds.map((w) => w.subjectId).join(' '));
for (const cid of claudeClients) {
  const c = clients.find((x) => x.id === cid)!;
  const rules = expectedSubject(cid, START_TIER[cid] ?? c.tier) ?? 'stay';
  const mine = reviews.find((w) => w.clientId === cid)?.subjectId ?? 'stay';
  if (rules !== mine) console.log(`  ·   ${c.name}: Claude chose ${mine}; rules said ${rules}`);
}
check(reviews.every((w) => w.requiredRole === 'CONTROLLER'), 'Every review needs a controller');
check(!reviews.some((w) => w.subjectId.startsWith('tier:') && clients.find((c) => c.id === w.clientId)?.strategic),
  'No tier change proposed for a strategic client');

// Autonomy: nothing for a tier 1 or 2 (or strategic) client applies on its own; worst cases wait too.
const governed = [...db.workItem.iter()].filter((w) => ['CREDIT_REVIEW', 'POLICY_DRAFT', 'EXPLOIT_FLAG'].includes(w.kind));
const byClient = (id: string) => clients.find((c) => c.id === id);
const bigAccount = (id: string) => (START_TIER[id] ?? 9) <= 2 || !!byClient(id)?.strategic;
const autoBig = governed.filter((w) => w.autoApplied && bigAccount(w.clientId));
check(!autoBig.length, 'Nothing auto-approved for a tier 1 or 2 (or strategic) client', autoBig.map((w) => w.title).join('; '));
const autoWorst = governed.filter((w) => w.autoApplied && w.kind === 'CREDIT_REVIEW'
  && (w.subjectId.startsWith('review:') || /->(1|2|5)$/.test(w.subjectId)));
check(!autoWorst.length, 'Worst cases (a review, a move to tier 1, 2 or 5) were not auto-approved', autoWorst.map((w) => w.title).join('; '));
const waiting = governed.filter((w) => !w.autoApplied && w.state === 'PROPOSED');
const wronglyWaiting = waiting.filter((w) => !bigAccount(w.clientId) && w.kind === 'EXPLOIT_FLAG');
check(!wronglyWaiting.length, 'Exploit alerts on tier 3 to 5 clients are acknowledged automatically', wronglyWaiting.map((w) => w.title).join('; '));
const autoCount = governed.filter((w) => w.autoApplied).length;
console.log(`  ·   ${autoCount} auto-approved, ${waiting.length} waiting for a controller`);

console.log('\nClient                    Tier  Proposed     Rel  Val  Coverage  Settle      Flags');
for (const c of clients) {
  const p = profiles.get(c.id);
  const review = reviews.find((w) => w.clientId === c.id);
  const auto = review?.autoApplied ? " (auto)" : "";
  const proposed = (!review ? '—' : review.subjectId.startsWith('review:') ? 'review' : review.subjectId.split('->')[1]!) + auto;
  const own = flags.filter((f) => f.clientId === c.id).map((f) => f.pattern).join(', ');
  console.log(
    `${c.name.padEnd(25)} ${String(c.tier).padEnd(5)} ${proposed!.padEnd(11)} ${String(p?.reliabilityScore ?? '-').padStart(3)}  `
    + `${String(p?.valueScore ?? '-').padStart(3)}  ${(p ? p.coverageRatio.toFixed(2) : '-').padStart(8)}  ${(p?.expectedSettleOn ?? '-').padEnd(10)}  ${own}`,
  );
}

conn.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
