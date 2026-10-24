import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';

export function createClaude(apiKey: string | undefined): Anthropic | undefined {
  return apiKey ? new Anthropic({ apiKey }) : undefined;
}
