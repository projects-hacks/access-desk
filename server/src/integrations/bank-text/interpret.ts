import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/**
 * Claude reads remittance text the rules couldn't: "JAN 2026 CUSTODY AND
 * TRADING FEES - THANK YOU" → period 2026-01, products custody + trading.
 * The answer is a hint for matching, never a decision: payment checking still
 * requires the amounts to fit exactly.
 */
export const RemittanceHints = z.object({
  invoiceNumbers: z.array(z.string()).describe('Invoice numbers mentioned, digits only'),
  clientIds: z.array(z.string()).describe('Client ids like ORG-90412'),
  periods: z.array(z.string()).describe('Billing months the payment is for, as YYYY-MM'),
  products: z.array(z.enum(['CUSTODY', 'TRADING', 'FINANCING', 'API'])).describe('Fee types the payment is for'),
  purpose: z.enum(['invoice_payment', 'prepayment', 'refund', 'loan', 'unclear']),
  confidence: z.number().min(0).max(1),
});
export type RemittanceHints = z.infer<typeof RemittanceHints>;

const MODEL = 'claude-opus-5-5';
const CACHE_FILE = join(import.meta.dirname, '../../../../.data/remittance-cache.json');

const SYSTEM = `You read the free-text remittance field of incoming bank payments to an institutional crypto platform.
Clients are billed monthly for custody fees, trading fees, financing interest and API usage.
Extract only what the text states or clearly implies. Year context: the current date is in March 2026, so "JAN" without a year means 2026-01.
If the text is not about a payment to us, say purpose "unclear" with low confidence.`;

/** Caches answers by text, so a re-sync or a second process never pays twice for the same memo. */
export class RemittanceInterpreter {
  private cache: Record<string, RemittanceHints> = {};

  constructor(private readonly client: Anthropic | undefined) {
    if (existsSync(CACHE_FILE)) this.cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  }

  static fromEnv(apiKey: string | undefined): RemittanceInterpreter {
    return new RemittanceInterpreter(apiKey ? new Anthropic({ apiKey }) : undefined);
  }

  get enabled() {
    return this.client !== undefined;
  }

  async interpret(remittance: string): Promise<RemittanceHints | undefined> {
    const key = createHash('sha256').update(remittance).digest('hex').slice(0, 16);
    const cached = this.cache[key];
    if (cached) return cached;
    if (!this.client) return undefined;

    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: `Remittance text: ${remittance}` }],
      output_config: { effort: 'low', format: zodOutputFormat(RemittanceHints) },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return undefined;
    this.cache[key] = response.parsed_output;
    writeFileSync(CACHE_FILE, JSON.stringify(this.cache, null, 2));
    return response.parsed_output;
  }
}
