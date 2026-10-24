# History (12 months)

Mar 2025 – Jan 2026, before the bank window. Generated in `server/src/dataset/history.ts`, synced by the `history` source, checked by `pnpm sync:verify`.

## What's in the database

| Data | Where | Count |
|---|---|---|
| Invoices, all paid, with `paid_on` | `invoice` (issued before 2026-01-01) | ~726 |
| Payments billing applied | `cash_movement` with `is_history = true`, `source = 'history'` | 339 |
| Past decisions and outcomes | `precedent` with `source = 'history'` | 12 |
| Weekly trend | `metric_snapshot` (`share_needing_human`, `handled_automatically`) | 12 weeks |

History cash goes through payment checking like any payment, quietly: no work items, no ticker rows.

## Patterns planted for the exploit sub-agent

| Client | Pattern | How to see it |
|---|---|---|
| Juniper Labs | Pays on day 20, one day before the day-21 restriction | `paid_on - due_on = 20` on every invoice |
| Wrenfield Digital | Partial payments reset aging | Two history payments per invoice: 50% at day 8, rest at day 33 |
| Monarch Rails | Pays the restricted product only | API invoices paid within 2 days, custody at day 30 |
| Halcyon Capital | Pays only at quarter end | `paid_on` is always a quarter end |
| Kestrel Quant | Recently late | Late in each of Oct, Nov, Dec 2025, always within 30 days |

## Precedents for policy drafting

PRC-0001 to PRC-0003 are overrides of pol-003 ("hold amount + no new positions") to "hold amount only" near renewal (Fieldstone, Ember, Polaris). The live Kestrel override on Mar 3 makes four, which is what pol-014 is drafted from. The rest are plain decisions with outcomes (Bluefin custody debit, Orchard netting, Tessellate prepay, Ivory Lane paid at day 41) for replay. Outcomes like "Paid in 4d" match real payments in the history.

Not modelled: custody withdrawal history (the design's Vantage "withdraws before due dates" pattern), and Tessellate's "pays only the restricted product" (it has one product; Monarch carries that pattern).
