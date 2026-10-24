/**
 * Two controller seats, because nobody approves their own proposal: what Controller A
 * proposes, Controller B approves. Pick a window's seat with ?as=a or ?as=b (remembered).
 */
const SEATS = {
  a: import.meta.env.VITE_STDB_CONTROLLER_TOKEN as string | undefined,
  b: import.meta.env.VITE_STDB_CONTROLLER_B_TOKEN as string | undefined,
};
export type Seat = keyof typeof SEATS;

function currentSeat(): Seat {
  const asked = new URLSearchParams(window.location.search).get('as');
  if (asked === 'a' || asked === 'b') {
    try { localStorage.setItem('controller-seat', asked); } catch { /* private window */ }
    return asked;
  }
  try { return localStorage.getItem('controller-seat') === 'b' ? 'b' : 'a'; } catch { return 'a'; }
}

export const seat = currentSeat();

/** Reconnect this window as the other controller. */
export function switchController(to: Seat) {
  try { localStorage.setItem('controller-seat', to); } catch { /* private window */ }
  const url = new URL(window.location.href);
  url.searchParams.set('as', to);
  window.location.assign(url);
}

export const config = {
  stdbUri: import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com',
  stdbDatabase: import.meta.env.VITE_STDB_DATABASE ?? 'access-desk-calhacks13',
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  /** This window's controller identity: needed to approve or reject work items. Reads work without it. */
  stdbToken: SEATS[seat] ?? SEATS.a,
  /** Sent as x-demo-key on demo POSTs to the hosted API. */
  demoKey: import.meta.env.VITE_DEMO_KEY as string | undefined,
};
