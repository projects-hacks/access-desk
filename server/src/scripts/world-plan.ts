/**
 * Dry run of the world engine: reads the live database and prints the next events it would
 * perform, with the sim date moving at the configured pace. Writes nothing (no bank, no database).
 * Usage: pnpm --filter @access-desk/server world:plan [events=20] [seed]
 */
import { loadDataset } from '../dataset';
import { addDays } from '../dataset/dates';
import { connectStdb } from '../lib/stdb';
import { env } from '../lib/env';
import { invoiceKey, invoicesToIssue } from '../world/billing';
import { clockDecision } from '../world/clock';
import { worldConfig } from '../world/engine';
import { applyEvent, chooseEvent, describeEvent, formatUsd, seeded, type WorldSnapshot } from '../world/events';
import { PERSONALITIES, PERSONALITY_TEXT, deriveProfiles } from '../world/personality';
import { WORLD_TABLES, readSnapshot } from '../world/snapshot';

const count = Math.max(1, Number(process.argv[2] ?? 20));
const seed = Number(process.argv[3] ?? Date.now() % 100_000);
const ds = loadDataset();
const profiles = deriveProfiles(ds);
const cfg = worldConfig();
const rng = seeded(seed);

const { conn } = await connectStdb();
await new Promise<void>((resolve) => conn.subscriptionBuilder().onApplied(() => resolve()).subscribe(WORLD_TABLES));
const { snapshot: first, clock } = readSnapshot(conn.db, ds, profiles);

const clockWord = {
  ok: `already at 1 day per ${cfg.secondsPerDay}s`,
  resume: `paused: the engine would resume it at 1 day per ${cfg.secondsPerDay}s`,
  paused: `paused for under ${cfg.pauseGraceMs / 1000}s: left alone for now, resumed after that`,
  foreign: `running at 1 day per ${clock.secondsPerDay}s${clock.runUntil ? ` until ${clock.runUntil}` : ''}: set by someone else, left alone`,
}[clockDecision(clock, { secondsPerDay: cfg.secondsPerDay, graceMs: cfg.pauseGraceMs }, Date.now())];
console.log(`World plan against ${env.STDB_DATABASE} (read only, seed ${seed})`);
console.log(`Sim date ${first.simDate}; clock ${clockWord}`);
console.log(`Cadence: a client event every ${cfg.eventMinMs / 1000}-${cfg.eventMaxMs / 1000}s, at most ${cfg.clientDayCap} per client per sim day\n`);

console.log('Personalities (from each client\'s own history):');
for (const p of PERSONALITIES) {
  const names = [...profiles.values()].filter((x) => x.personality === p).map((x) => x.name);
  console.log(`  ${p.padEnd(12)} ${String(names.length).padStart(2)}  ${PERSONALITY_TEXT[p]}${names.length ? ` · ${names.join(', ')}` : ''}`);
}

const ready = first.clients.filter((c) => chooseEvent({ ...first, clients: [c] }, seeded(1), { clientDayCap: 99 })?.kind === 'pay').length;
const overdue = first.clients.reduce((n, c) => n + c.invoices.filter((i) => i.dueOn < first.simDate).length, 0);
console.log(`\nBook now: ${first.clients.reduce((n, c) => n + c.invoices.length, 0)} unpaid invoices, ${overdue} past due, ${ready} clients with a payment ready\n`);

// Day fraction already elapsed on the running clock, so the first event lands on the right date.
const startOffset = clock.secondsPerDay > 0 ? Math.min(cfg.secondsPerDay, (Date.now() - clock.updatedAtMs) / 1000) : 0;
const issuedKeys = new Set([...conn.db.invoice.iter()].map((i) => invoiceKey(i.clientId, i.product, i.period)));
const issuedIds = [...conn.db.invoice.iter()].map((i) => i.id);

let snap: WorldSnapshot = first;
let elapsed = startOffset;
let simDate = first.simDate;
const tally: Record<string, number> = {};
const byPersonality: Record<string, number> = {};
const log = (n: number, text: string) => console.log(`${String(n).padStart(3)}  +${Math.floor((elapsed - startOffset) / 60)}:${String(Math.floor((elapsed - startOffset) % 60)).padStart(2, '0')}  ${simDate}  ${text}`);
const billAt = (date: string) => {
  const issued = invoicesToIssue(ds, date, { ids: issuedIds, keys: issuedKeys });
  if (!issued.length) return;
  for (const i of issued) {
    issuedKeys.add(invoiceKey(i.clientId, i.product, i.period));
    issuedIds.push(i.id);
    snap.clients.find((c) => c.profile.clientId === i.clientId)!.invoices.push({
      id: i.id, product: i.product, dueOn: i.dueOn, amountCents: i.amountCents, paidCents: 0, disputed: false, inFlight: false,
    });
  }
  console.log(`     ${simDate}  billing: would issue ${issued.length} invoices for ${[...new Set(issued.map((i) => i.period))].join(', ')} (${issued[0]!.id}..${issued.at(-1)!.id}, ${formatUsd(issued.reduce((s, i) => s + i.amountCents, 0))})`);
};

billAt(simDate);
for (let n = 1; n <= count; n++) {
  elapsed += cfg.eventMinMs / 1000 + rng() * (cfg.eventMaxMs - cfg.eventMinMs) / 1000;
  const date = addDays(first.simDate, Math.floor(elapsed / cfg.secondsPerDay));
  if (date !== simDate) {
    simDate = date;
    snap = { ...snap, simDate, clients: snap.clients.map((c) => ({ ...c, eventsToday: 0 })) };
    billAt(simDate);
  }
  const event = chooseEvent(snap, rng, { clientDayCap: cfg.clientDayCap });
  if (!event) {
    log(n, '(nothing plausible)');
    continue;
  }
  const profile = profiles.get(event.clientId)!;
  tally[event.kind] = (tally[event.kind] ?? 0) + 1;
  byPersonality[profile.personality] = (byPersonality[profile.personality] ?? 0) + 1;
  log(n, `${event.kind.padEnd(10)} ${describeEvent(event, profile.name)}  [${event.why}]`);
  snap = applyEvent(snap, event, n);
}
console.log(`\nBy kind: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`By personality: ${Object.entries(byPersonality).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log('Dry run only: no bank or database writes were made. Dates assume the clock holds its pace; gamers\' cure periods and refusals are decided by the database when it really happens.');
conn.disconnect();
process.exit(0);
