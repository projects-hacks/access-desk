import type Anthropic from '@anthropic-ai/sdk';
import type { Agent } from '../agent';

/** Scores clients (value, reliability, coverage), assigns tiers and per-product limits. */
export class CreditAnalyst implements Agent {
  readonly name = 'credit-analyst';
  constructor(private readonly claude: Anthropic) {}

  async run() {
    // TODO: read clients and invoices, score, propose CREDIT_REVIEW work items.
  }
}
