const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdShort = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Amounts are integer cents (bigint from the database). */
export function money(cents: bigint | number, short = false): string {
  const dollars = Number(cents) / 100;
  return (short ? usdShort : usd).format(dollars);
}

/** Sim dates are 'YYYY-MM-DD'; shown as 'Tue, Mar 3, 2026'. */
export function simDay(date: string | undefined): string {
  if (!date) return '…';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** 'PAYMENT_MATCH' → 'Payment match'. */
export function label(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** JSON columns hold strings; bad JSON shows as empty rather than crashing a screen. */
export function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Dates inside a sentence: '2026-03-14' becomes 'Mar 14'. */
export function plainDates(text: string): string {
  return text.replace(/\b\d{4}-(\d{2})-(\d{2})\b/g, (_all, m: string, d: string) => `${MONTHS[+m - 1] ?? m} ${+d}`);
}

const KEEP_UPPER = new Set(['LP', 'LLC', 'LLP', 'LTD', 'PLC', 'USD', 'USDC', 'ACH', 'API', 'RM', 'BTC', 'ETH', 'SOL', 'II', 'III', 'NA', 'AG', 'SA']);

/** "ZEPHYR CAPITAL MGMT LP" as a bank sends it reads "Zephyr Capital Mgmt LP". */
export function titleCaseName(run: string): string {
  return run.split(/(\s+)/).map((w) => (KEEP_UPPER.has(w.replace(/[.,]/g, '')) || /^\s+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join('');
}

/** Pattern codes the agents use, in the words on the Exploits screen. */
const PATTERN_WORDS: Record<string, string> = {
  restriction_eve: 'pays only on the eve of a restriction',
  partial_reset: 'small partial payments that reset the clock',
  pays_restricted_only: 'pays only the product that was restricted',
  quarter_end: 'holds payments until quarter end',
  recent_late: 'paying later than it used to',
  lateness_jump: 'suddenly paying much later',
  dispute_delay: 'disputes that delay payment',
  withdrawal_during_cure: 'withdrew cash during its cure period',
};

/** A pattern code in a sentence, as the words the Exploits screen uses. */
const patternWords = (text: string) => text.replace(/\b([A-Za-z]+(?:_[a-z]+)+)\b/g, (w, _c, at: number) => {
  const words = PATTERN_WORDS[w.toLowerCase()];
  if (!words) return w;
  const lead = at === 0 || /[.!?]\s*$|^\s*-\s*$|\n\s*$/.test(text.slice(Math.max(0, at - 3), at));
  return `${lead ? 'The' : 'the'} pattern “${words}”`;
});

/**
 * Display safety net for text the module or an agent wrote: dates become "Mar 14", client ids become
 * names, snake_case becomes words, a client's own policy key reads "this client's own policy", and
 * policy, work item, score and section references are dropped. "Acme Corp: Acme: ..." keeps one prefix.
 */
export function plainText(text: string, names: Map<string, string> = new Map()): string {
  const out = plainDates(patternWords(text))
    // Formula asides like "(1.00 vs >= 0.9)" are for the evaluator, not the reader.
    .replace(/\s*\([^()]*(?:>=|<=)[^()]*\)/g, '')
    .replace(/\bpol-\d+:ORG-\d+(?:@\d+)?/gi, "this client's own policy")
    .replace(/(own policy)@\d+/g, '$1')
    .replace(/\bORG-\d+\b/g, (id) => names.get(id) ?? 'the client')
    .replace(/\bpol-\d+\b/gi, 'policy')
    // Bank and work item refs mean nothing in a sentence; the screen shows the payment itself.
    .replace(/\s*\(\s*(?:WI|AC|TX|JD|WE|CW|DSP)-[A-Z]?\d+\s*\)/g, '')
    .replace(/\s+(?:WI|AC|TX|JD|WE|CW|DSP)-[A-Z]?\d+\b/g, '')
    // A wallet address reads as 0xa47d…7b9c.
    .replace(/\b(0x[0-9a-fA-F]{4})[0-9a-fA-F]{8,}([0-9a-fA-F]{4})\b/g, '$1…$2')
    .replace(/\b(?:WIRE|USDC)\b(?= (?:of|from|to)\b)/g, (w) => (w === 'WIRE' ? 'wire' : w))
    .replace(/\b[A-Z][A-Z&'.]+(?:\s+[A-Z][A-Z&'.]+)+\b/g, titleCaseName)
    .replace(/\s*·?\s*\bscores? \d+(\.\d+)?/gi, '')
    .replace(/\s*\(?§\s*[\d.]+\)?/g, '')
    .replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (w) => w.toLowerCase().replace(/_/g, ' '))
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => w.replace(/_/g, ' '))
    .replace(/\(([A-Z]{3,}(?:, [A-Z]{3,})*)\)/g, (_all, w: string) => `(${w.toLowerCase()})`)
    .replace(/\bapi\b/gi, 'API')
    .replace(/\b(Lp|Llc|Llp|Ltd|Plc)\b/g, (w) => w.toUpperCase())
    .replace(/^([^:]{2,60}): ([^:]{2,60}): /, (all, a: string, b: string) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x.startsWith(y) || y.startsWith(x) ? `${a.length >= b.length ? a : b}: ` : all;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Reasoning as separate points. Agents write one point per "- " line; older text written as one
 * paragraph is split at sentence ends and semicolons. Dashes used as punctuation become commas.
 */
export function points(text: string): string[] {
  const clean = patternWords(text)
    .replace(/\b[A-Za-z]+(?:_[a-z]+)+\b/g, (w) => w.replace(/_/g, ' '))
    .replace(/\s*[—–]\s*/g, ', ')
    // Older proposals spelled their criteria as formulas.
    .replace(/share paid within grace >= 1(?:\.0+)?\b/g, 'every invoice paid within grace')
    .replace(/share paid within grace >= (0?\.\d+)/g, (_m, x: string) => `${Math.round(Number(x) * 100)}% of invoices paid within grace`)
    .replace(/mean days late <= ([\d.]+)/g, 'average lateness of $1 days or less')
    .replace(/max days late <= ([\d.]+)/g, 'no invoice more than $1 days late')
    .replace(/\bEvidence: /g, 'Invoices: ')
    .replace(/\bTerms: /g, 'Change: ')
    .replace(/\bSuccess: /g, 'Works if: ');
  const raw = bulletLines(clean) ?? clean.split(/;\s+|(?<=[a-z0-9)%][.!?])\s+(?=[A-Z])/);
  return raw
    .map((p) => p.trim().replace(/[.;]+$/, ''))
    .filter(Boolean)
    .map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}.`);
}

/** The lines of text an agent wrote as "- " points, or null when it is one paragraph. */
export function bulletLines(text: string): string[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 && lines.every((l) => l.startsWith('- ')) ? lines.map((l) => l.slice(2)) : null;
}

/** Asks the console to open one request in Approvals (the app listens; any screen can ask). */
export function openApproval(clientId: string, workItemId?: bigint) {
  window.dispatchEvent(new CustomEvent('neo:open-approval', { detail: { clientId, workItemId } }));
}
