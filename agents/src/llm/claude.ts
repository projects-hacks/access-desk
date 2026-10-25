import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { DecisionUnavailable } from './errors';
import type { Provider } from './index';

const TIMEOUT_MS = 45_000;
const MAX_TOKENS = 8000;

let client: Anthropic | undefined;

/** The Claude API, the backup when Droid is missing or fails. The schema must be strict-mode compatible. */
export const claude: Provider = {
  name: 'anthropic',
  async answer(prompt, schema) {
    client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
    const r = await client.messages.create({
      model: env.LLM_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
    if (r.stop_reason !== 'end_turn') throw new DecisionUnavailable(`claude stop_reason ${r.stop_reason}`);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    if (!text) throw new DecisionUnavailable('claude returned no answer');
    return text;
  },
};
