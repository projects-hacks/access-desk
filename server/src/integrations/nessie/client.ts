/**
 * Minimal Nessie REST client (https://prod.nessieisreal.com/docs).
 *
 * Quirks handled here: the key goes in the query string, creates return
 * `{ code, message, objectCreated }`, empty lists come back as 404, and the
 * gateway in front of it times out at ~29s.
 */
export interface NessieCustomer {
  _id: string;
  first_name: string;
  last_name: string;
}

export interface NessieAccount {
  _id: string;
  type: 'Checking' | 'Savings' | 'Credit Card';
  nickname: string;
  account_number: string;
  customer_id: string;
}

export interface NessieTransaction {
  _id: string;
  medium: string;
  transaction_date: string;
  status: 'pending' | 'completed' | 'cancelled';
  amount: number;
  description: string;
}

export interface NessieBill {
  _id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'recurring';
  payee: string;
  nickname: string;
  payment_date: string;
  payment_amount: number;
}

export interface Address {
  street_number: string;
  street_name: string;
  city: string;
  state: string;
  zip: string;
}

export class NessieError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Nessie ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class NessieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('key', this.apiKey);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
      // Only retry when the server clearly did nothing; a retried create could duplicate.
      if (RETRYABLE.has(res.status) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new NessieError(res.status, text, path);
    }
  }

  private async create<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request<{ objectCreated: T }>('POST', path, body);
    return res.objectCreated;
  }

  /** Lists return 404 "No ... found" when empty. */
  private async list<T>(path: string): Promise<T[]> {
    try {
      return await this.request<T[]>('GET', path);
    } catch (err) {
      if (err instanceof NessieError && err.status === 404) return [];
      throw err;
    }
  }

  createCustomer(body: { first_name: string; last_name: string; address: Address }) {
    return this.create<NessieCustomer>('/customers', body);
  }

  async createAccount(customerId: string, body: { type: NessieAccount['type']; nickname: string; rewards: number; balance: number }) {
    const created = await this.create<NessieAccount>(`/customers/${customerId}/accounts`, body);
    return created.account_number ? created : this.getAccount(created._id);
  }

  getAccount(id: string) {
    return this.request<NessieAccount>('GET', `/accounts/${id}`);
  }

  createBill(accountId: string, body: Omit<NessieBill, '_id'> & { recurring_date: number }) {
    return this.create<NessieBill>(`/accounts/${accountId}/bills`, body);
  }

  updateBill(id: string, body: Partial<Omit<NessieBill, '_id'>>) {
    return this.request<string>('PUT', `/bills/${id}`, body);
  }

  createDeposit(accountId: string, body: Omit<NessieTransaction, '_id'>) {
    return this.create<NessieTransaction>(`/accounts/${accountId}/deposits`, body);
  }

  createWithdrawal(accountId: string, body: Omit<NessieTransaction, '_id'>) {
    return this.create<NessieTransaction>(`/accounts/${accountId}/withdrawals`, body);
  }

  listDeposits(accountId: string) {
    return this.list<NessieTransaction>(`/accounts/${accountId}/deposits`);
  }

  listWithdrawals(accountId: string) {
    return this.list<NessieTransaction>(`/accounts/${accountId}/withdrawals`);
  }

  listBills(accountId: string) {
    return this.list<NessieBill>(`/accounts/${accountId}/bills`);
  }

  deleteBill(id: string) {
    return this.request<unknown>('DELETE', `/bills/${id}`);
  }

  deleteDeposit(id: string) {
    return this.request<unknown>('DELETE', `/deposits/${id}`);
  }

  deleteWithdrawal(id: string) {
    return this.request<unknown>('DELETE', `/withdrawal/${id}`);
  }

  updateDeposit(id: string, body: Partial<Omit<NessieTransaction, '_id'>>) {
    return this.request<string>('PUT', `/deposits/${id}`, body);
  }

  updateWithdrawal(id: string, body: Partial<Omit<NessieTransaction, '_id'>>) {
    return this.request<string>('PUT', `/withdrawal/${id}`, body);
  }
}

/** The operations the rest of the app uses; implemented by NessieClient and FakeNessie. */
export type NessieApi = Pick<
  NessieClient,
  | 'createCustomer' | 'createAccount' | 'getAccount'
  | 'createBill' | 'updateBill' | 'listBills' | 'deleteBill'
  | 'createDeposit' | 'createWithdrawal' | 'listDeposits' | 'listWithdrawals'
  | 'updateDeposit' | 'updateWithdrawal' | 'deleteDeposit' | 'deleteWithdrawal'
>;
