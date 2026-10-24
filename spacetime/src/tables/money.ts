import { table, t } from 'spacetimedb/server';

export const invoice = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    product: t.string(),
    label: t.string(),
    period: t.string(),
    issuedOn: t.string(),
    dueOn: t.string(),
    amountCents: t.i64(),
    /** What the billing system has applied. */
    sourcePaidCents: t.i64(),
    /** Billing's amount plus our own applications not yet in billing. Status derives from this. */
    paidCents: t.i64(),
    /** Date the invoice became fully paid. */
    paidOn: t.string().optional(),
    status: t.string(),
  },
);

export const dispute = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    invoiceId: t.string().index('btree'),
    clientId: t.string().index('btree'),
    amountCents: t.i64(),
    reason: t.string(),
    openedOn: t.string(),
    status: t.string(),
    owner: t.string(),
  },
);

/** Every movement of cash, bank or chain, seen from the platform's side. */
export const cashMovement = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    source: t.string(),
    platformAccount: t.string(),
    direction: t.string(),
    rail: t.string(),
    amountCents: t.i64(),
    valueOn: t.string(),
    status: t.string(),
    memo: t.string(),
    origName: t.string(),
    origAccount: t.string(),
    refs: t.array(t.string()),
    bankRef: t.string().index('btree'),
    reverses: t.string().optional(),
    rawId: t.string(),
    matchStatus: t.string(),
    isHistory: t.bool(),
  },
);

export const paymentApplication = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    movementId: t.string().index('btree'),
    invoiceId: t.string().index('btree'),
    amountCents: t.i64(),
    method: t.string(),
    policyRef: t.string(),
    workItemId: t.u64().optional(),
    reversed: t.bool(),
    /** Billing has confirmed this application (gateway APPLY_PAYMENT done). Always true for `prior`. */
    posted: t.bool(),
    /** Billing has confirmed the reversal (gateway REVERSE_PAYMENT done). */
    reversalPosted: t.bool(),
  },
);

export const clientCredit = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    kind: t.string(),
    amountCents: t.i64(),
    movementId: t.string().optional(),
  },
);

/** General ledger lines, synced from the GL and written through when our journals post. */
export const ledgerEntry = table(
  { public: true },
  {
    /** `<journalId>:<line>` */
    id: t.string().primaryKey(),
    journalId: t.string().index('btree'),
    postedOn: t.string(),
    accountCode: t.string().index('btree'),
    debitCents: t.i64(),
    creditCents: t.i64(),
    /** Source document: invoice id or bank reference. */
    ref: t.string().index('btree'),
    memo: t.string(),
    /** billing | treasury | access-desk */
    source: t.string(),
    workItemId: t.u64().optional(),
  },
);
