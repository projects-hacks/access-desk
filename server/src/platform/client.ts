import type { GatewayAction, GatewayResult } from './commands';
import { ROUTES } from './routes';
import { PlatformError, type PlatformSimulator } from './simulator';

/** Raised for writes the platform refused: retrying won't help. */
export class PermanentError extends Error {}

/** Bank-only commands (refunds, returns) never reach the platform. */
type PlatformAction = Exclude<GatewayAction, { type: 'REFUND' | 'RETURN_PAYMENT' }>;

export interface PlatformApi {
  execute(commandId: string, action: PlatformAction): Promise<GatewayResult>;
}

/** HTTP client for the platform's write APIs, used by the gateway in the server. */
export class PlatformClient implements PlatformApi {
  constructor(private readonly baseUrl: string) {}

  async execute(commandId: string, action: PlatformAction): Promise<GatewayResult> {
    const res = await fetch(new URL(`${this.baseUrl}${ROUTES[action.type]}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId, action }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (res.ok) return JSON.parse(body) as GatewayResult;
    if (res.status === 400 || res.status === 422) throw new PermanentError(`${res.status}: ${body}`);
    throw new Error(`platform ${res.status}: ${body}`);
  }
}

/** Same contract, in process: for one-off scripts that run without the server. */
export class LocalPlatform implements PlatformApi {
  constructor(private readonly sim: PlatformSimulator) {}

  async execute(commandId: string, action: PlatformAction): Promise<GatewayResult> {
    try {
      return this.sim.apply(commandId, action);
    } catch (err) {
      if (err instanceof PlatformError) throw new PermanentError(err.message);
      throw err;
    }
  }
}
