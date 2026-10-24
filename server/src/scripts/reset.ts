/**
 * Puts the shared world back to Tue 2026-03-03 through the hosted server
 * (bank, database and the server's simulated platform together).
 * Usage: pnpm demo:reset   (needs VITE_API_URL and DEMO_KEY in .env)
 */
export {};

const url = process.env.VITE_API_URL;
if (!url) throw new Error('VITE_API_URL is not set: point it at the hosted server');
const res = await fetch(`${url}/demo/reset`, { method: 'POST', headers: { 'x-demo-key': process.env.DEMO_KEY ?? '' } });
if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
const r = (await res.json()) as { simDate: string; bank: { restored: number; deleted: number }; synced: { source: string; errors: number }[]; ms: number };
const errors = r.synced.filter((s) => s.errors);
console.log(`Reset to ${r.simDate} in ${(r.ms / 1000).toFixed(1)}s · bank ${r.bank.restored} restored, ${r.bank.deleted} deleted · ${errors.length ? `sync errors in ${errors.map((e) => e.source).join(', ')}` : 'sync clean'}`);
process.exit(errors.length ? 1 : 0);
