import type { SyncSource } from '../source';

/** Bank feed via Capital One Nessie. */
export class NessieSource implements SyncSource {
  readonly name = 'nessie';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  async fetchChanges(cursor: string | undefined) {
    if (!this.apiKey) return { rows: [], cursor };
    // TODO: list accounts, then deposits/transfers per account; filter by cursor.
    return { rows: [], cursor };
  }
}
