import type Anthropic from '@anthropic-ai/sdk';
import type { Agent } from '../agent';

/** Recover first, restrict the unpaid product first, gentlest step first; restore on payment. */
export class AccessController implements Agent {
  readonly name = 'access-controller';
  constructor(private readonly claude: Anthropic) {}

  async run() {
    // TODO: pick the next RESTRICTION_LADDER step allowed by the contract,
    // propose RESTRICTION / RESTORE work items.
  }
}
