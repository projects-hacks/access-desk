import type { Ask } from '../types';

/**
 * The model rewords a notice so it reads like a careful person wrote it. The template (the facts)
 * is sent unless a wording passes the number check: every amount, date and id must be the draft's.
 */

const SYSTEM = `You rewrite notices from an institutional crypto prime broker's collections desk so they read like a \
careful person wrote them. You get the facts as a draft.

Rules:
- Keep every amount, date, invoice number, wire reference, clause number and work item number exactly as written \
in the draft, character for character. Do not round, reformat or convert them.
- Add no number, date or identifier that is not in the draft.
- Keep every fact in the draft, including every amount and invoice number. Add no new facts or promises.
- Plain text, no greeting line, no signature, no placeholders. At most 120 words.`;

const AUDIENCE: Record<string, string> = {
  email: "the client's finance team, by email",
  portal: 'the client, in the client portal',
  rm: "the client's relationship manager (an internal colleague)",
};
const TAG = /\s*\((?:ref WI|re RM)-\d+\)\s*$/;
const TOKEN = /[\w$.,\-/:]*\d[\w$.,\-/:]*/g;
const REQUIRED = /^(\$[\d,]+\.\d{2}|INV-\d+)$/;

const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The notice text only' } },
  required: ['text'],
  additionalProperties: false,
};

/** Every word that carries a digit (amounts, dates, ids, references), without trailing punctuation. */
export const tokens = (text: string) => new Set((text.match(TOKEN) ?? []).map((t) => t.replace(/[.,:;-]+$/, '')).filter(Boolean));

/** Why the rewrite can't be used, or undefined. Numbers must come from the draft; amounts and invoices must stay. */
export function safe(draft: string, rewrite: string): string | undefined {
  const allowed = tokens(draft);
  const used = tokens(rewrite);
  const invented = [...used].filter((t) => !allowed.has(t)).sort();
  if (invented.length) return `numbers not in the facts: ${invented.join(', ')}`;
  const dropped = [...allowed].filter((t) => REQUIRED.test(t) && !used.has(t)).sort();
  if (dropped.length) return `dropped from the facts: ${dropped.join(', ')}`;
  return undefined;
}

/** The text to send, and who worded it (an empty `by` means the template is returned as is). */
export async function wordNotice(ask: Ask, channel: string, body: string, context: string): Promise<{ text: string; by: string }> {
  const tag = TAG.exec(body);
  const draft = tag ? body.slice(0, tag.index) : body;
  let by = '';
  try {
    const text = await ask({
      system: SYSTEM,
      prompt: `Audience: ${AUDIENCE[channel] ?? channel}\n${context}\n\n<draft>\n${draft}\n</draft>\n\nAnswer as JSON: {"text": "<the notice>"}.`,
      schema: TEXT_SCHEMA,
      validate: (v, answered?: { provider: string }) => {
        by = answered?.provider ?? 'model';
        const text = String((v as { text?: unknown })?.text ?? '').trim();
        const problem = text ? safe(draft, text) : 'empty';
        if (problem) throw new Error(`number check failed (${problem})`);
        return text;
      },
    });
    if (typeof text !== 'string' || safe(draft, text)) return { text: body, by: '' };
    return { text: text + (tag?.[0] ?? ''), by };
  } catch {
    return { text: body, by: '' };
  }
}
