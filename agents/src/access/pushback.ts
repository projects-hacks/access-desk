import type { Ask } from '../types';

/** What a relationship manager's note is asking for, read by the model (keywords when it can't answer). */

export type Intent = 'already_paid' | 'material_event' | 'exception_request' | 'other';
export type EventType = 'acquisition' | 'merger' | 'insolvency' | 'wind_down' | 'regulatory' | 'other';

export interface RmReading {
  intent: Intent;
  summary: string;
  claimedAmountUsd: number | null;
  paymentReference: string | null;
  graceUntil: string | null;
  reason: string | null;
  eventType: EventType | null;
  counterparty: string | null;
  effectiveDate: string | null;
  /** Who read the note: a provider ("anthropic", "factory"), or "keywords". */
  readBy: string;
}

const LABELS: Record<string, string> = { anthropic: 'Claude', factory: 'Factory (Droid)', keywords: 'keyword rules' };
export const providerName = (provider: string) => LABELS[provider] ?? provider;
export const readerName = (reading: RmReading | undefined) => providerName(reading?.readBy ?? '');

const INTENTS: Intent[] = ['already_paid', 'material_event', 'exception_request', 'other'];
const EVENTS: EventType[] = ['acquisition', 'merger', 'insolvency', 'wind_down', 'regulatory', 'other'];

const SYSTEM = `You read notes a relationship manager (RM) at an institutional crypto prime broker writes about a client \
whose account may be restricted for unpaid fees. Classify what the RM is asking for.

- already_paid: the RM says the client has paid or sent a wire (even partially), so restrictions may be unnecessary.
- material_event: something that changes who the client is or whether it can pay: being acquired, a merger, \
insolvency or bankruptcy, winding down, a regulatory action. This holds even if the RM also asks to hold off.
- exception_request: the RM asks to hold off, grant a grace period, not freeze, or otherwise make an exception.
- other: anything else (context, questions, updates that ask for nothing).

If a note claims a payment, prefer already_paid: it can be checked against the bank feed right away. Otherwise prefer \
material_event over exception_request.
Extract only what the note states; leave a field null rather than guessing. Dates are YYYY-MM-DD; resolve relative \
dates ("Friday", "end of month") against today's date given in the message.`;

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra });

export const READING_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    summary: { type: 'string', description: 'One sentence, what the RM is saying' },
    claimed_amount_usd: nullable('number'),
    payment_reference: nullable('string', { description: 'Wire reference, IMAD, TRN or invoice ids the RM quotes' }),
    grace_until: nullable('string', { description: 'Date the RM asks to hold off until' }),
    reason: nullable('string', { description: 'Why the RM says an exception is warranted' }),
    event_type: { type: ['string', 'null'], enum: [...EVENTS, null] },
    counterparty: nullable('string', { description: 'Acquirer or merger partner, if named' }),
    effective_date: nullable('string', { description: 'Expected closing or effective date' }),
  },
  required: ['intent', 'summary', 'claimed_amount_usd', 'payment_reference', 'grace_until', 'reason', 'event_type', 'counterparty', 'effective_date'],
  additionalProperties: false,
};

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The model's answer as a reading; throws on anything unusable. */
export function parseReading(v: unknown, readBy: string): RmReading {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!INTENTS.includes(o.intent as Intent)) throw new Error(`unknown intent ${JSON.stringify(o.intent)}`);
  if (typeof o.summary !== 'string') throw new Error('missing summary');
  const amount = typeof o.claimed_amount_usd === 'number' && Number.isFinite(o.claimed_amount_usd) ? o.claimed_amount_usd : null;
  return {
    intent: o.intent as Intent, summary: o.summary, claimedAmountUsd: amount, paymentReference: text(o.payment_reference), graceUntil: text(o.grace_until),
    reason: text(o.reason), eventType: EVENTS.includes(o.event_type as EventType) ? (o.event_type as EventType) : null, counterparty: text(o.counterparty),
    effectiveDate: text(o.effective_date), readBy,
  };
}

/** The model reads the note; any failure (no answer, unusable answer) falls back to keywords. */
export async function readNote(ask: Ask, note: string, clientName: string, today: string): Promise<RmReading> {
  try {
    return await ask({
      system: SYSTEM, prompt: `Today: ${today}\nClient: ${clientName}\nRM note:\n${note}`, schema: READING_SCHEMA,
      validate: (v, by?: { provider: string }) => parseReading(v, by?.provider ?? ''),
    });
  } catch {
    return byKeywords(note);
  }
}

const PAID = /\b(paid|wired?|sent|remitted|payment (went|is) out|in transit|mt103|imad|trn)\b/i;
const EVENT_WORDS: Record<string, RegExp> = {
  acquisition: /\b(acquir\w*|acquisition|bought by|takeover|buyout)\b/i,
  merger: /\bmerg(er|ing|e)\b/i,
  insolvency: /\b(insolven\w*|bankrupt\w*|chapter (7|11)|receivership|administration)\b/i,
  wind_down: /\b(wind(ing)?[- ]down|shutting down|liquidat\w*)\b/i,
};
const EXCEPTION = /\b(don'?t|do not|hold off|grace|extension|exception|pause|wait|until|strategic)\b/i;
const AMOUNT = /\$\s?([\d,]+(?:\.\d{2})?)/;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const COUNTERPARTY = /\b(?:acquired by|bought by|merging with|merger with|sold to)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/;
const REFERENCE = /\b(?:IMAD|TRN|ref(?:erence)?)\b[:#\s]*((?=[A-Z0-9-]*\d)[A-Z0-9-]{6,})/i;

export function byKeywords(note: string): RmReading {
  const amount = AMOUNT.exec(note)?.[1];
  const date = DATE.exec(note)?.[1];
  const ref = REFERENCE.exec(note)?.[1];
  const party = COUNTERPARTY.exec(note)?.[1];
  const event = (Object.keys(EVENT_WORDS) as EventType[]).find((kind) => EVENT_WORDS[kind]!.test(note));
  const intent: Intent = PAID.test(note) ? 'already_paid' : event ? 'material_event' : EXCEPTION.test(note) ? 'exception_request' : 'other';
  return {
    intent, summary: note.trim().slice(0, 200), claimedAmountUsd: amount ? Number(amount.replace(/,/g, '')) : null, paymentReference: ref ?? null,
    graceUntil: date && intent === 'exception_request' ? date : null, eventType: intent === 'material_event' ? event ?? null : null,
    counterparty: party && intent === 'material_event' ? party : null, effectiveDate: date && intent === 'material_event' ? date : null,
    reason: intent === 'exception_request' ? note.trim().slice(0, 200) : null, readBy: 'keywords',
  };
}
