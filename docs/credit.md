# Credit analyst (seat 1)

Scores every client, flags clients gaming the payment terms, and proposes tier changes on the platform's 1–5 scale (1 best). It never restricts a lever, holds cash, debits custody, approves its own work, changes a strategic client's tier or edits contract terms. Plan: [seat1-build-plan.pdf](seat1-build-plan.pdf).

Code: `agents/src/desk_agents/credit/` (pure: `scoring.py`, `detectors.py`, `tiers.py`; `load.py` reads the database, `reasoning.py` writes the paragraph) and `agents/credit_analyst.py` (the 15 s loop). Today is always `clock.sim_date`; `load.py` cuts every book to it, so nothing dated later is read and a replay at an earlier date is honest.

## Scores (`credit_profile`)

Invoices that count: past due, not void, not under an open dispute. Lag = `paid_on − due_on` (open: today − due). dpd = max(0, lag). Weight = 0.5^(age/90).

| Score | Rule |
|---|---|
| Reliability 0–100 | 100 − lateness (0.8 × weighted mean dpd, cap 35) − frequency (20 × weighted share dpd > 10) − severity (15 if worst dpd in 180 days > 60, 8 if > 30) − paid in pieces (4 × weighted count with 2+ payments, cap 10) − disputes lost (1.5 per `no_change`, `credited` free, cap 15); then (m × raw + 3 × 70)/(m + 3), m = months scored |
| Value 0–100 | 75 × log of fees billed in 365 days, scaled smallest → largest client, + 25 × products / 4 |
| Coverage ratio | (USD custody if the §6.3 debit clause is signed + owed to client) ÷ undisputed unpaid; `coverage_detail` adds §7.2 holdable custody as a multiple of exposure |
| Expected settle | oldest open undisputed invoice's due date + weighted median lag (today if earlier) |

## Exploit detectors (`exploit_flag`, id `<pattern>:<client_id>`)

restriction day = grace + 1 + cure. Strategic clients get status `watch`, others `flagged`; a controller's `cleared` sticks.

| Pattern | Fires when | Planted on |
|---|---|---|
| `restriction_eve` | in the last 8 scored months, 6+ single-payment invoices, 85%+ paid on the same day after due, past grace | Juniper (14 of 14 on day 20) |
| `partial_reset` | 2+ invoices: first payment < 60%, balance after the restriction day | Wrenfield (11) |
| `pays_restricted_only` | median lag per product differs by 15+ days, slow one past grace | Monarch (API 2, custody 30) |
| `quarter_end` | 1–6 payment dates in 365 days, 2+ months of invoices per date | Halcyon (6 dates, 12 months) |
| `recent_late` | 2 of the last 3 paid months > 5 days late and their mean 7+ worse than before | Kestrel (12, 18, 9); Fieldstone once its Mar 2 lump sum is applied |
| `dispute_delay` | half the months disputed, 80% upheld `no_change`, 80% paid within 3 days of the ruling | Orchard (11 of 11, 22 of 22) |

`quarter_end` allows 6 dates, not the plan's 5: Halcyon's ordinary Feb 28 wire for January is the sixth (owner approved).

## Tiers

Base from reliability: ≥ 85 → 2, ≥ 70 → 3, ≥ 55 → 4, else 5. Value ≥ 75 lifts one tier (tier 1 needs reliability ≥ 85). Any flag caps at tier 3. Then, in order:

1. Strategic: never a tier change; a worse formula tier becomes a `review` (pol-022).
2. Upgrade: one step, only if reliability clears its band line by 3+ and `recent_late` didn't fire (pol-021).
3. Downgrade: up to two steps (pol-020).
4. No duplicates: a subject with an item in PROPOSED / NEEDS_INFO / APPROVED / POSTED, or rejected less than 30 sim days ago, isn't proposed again. A newer view of a client withdraws its older open review.

Confidence 0.7 within 5 points of a band line (55, 70, 85), else 0.9.

`CREDIT_REVIEW`: subject `tier:<client>:<from>-><to>` or `review:<client>`, title "Orchard Treasury: tier 3 → 5", amount = undisputed exposure, `proposal_json` {action, from_tier, to_tier, reliability, value, coverage_ratio, breakdown, flags, expected_settle_on}, required role CONTROLLER. One `EXPLOIT_FLAG` item per new flag (`exploit:<pattern>:<client>`). Reasoning is Claude (`ANTHROPIC_API_KEY`, 20 s timeout, ≤ 120 words, only the engine's numbers and invoice ids) or the template on any error.

## Reducers

| Reducer | Who | Does |
|---|---|---|
| `upsert_credit_profile` | AGENT, ADMIN | upsert by client; audit `CREDIT_SCORED` only when a score moves |
| `upsert_exploit_flag` | AGENT, ADMIN | upsert by id, keeps `cleared`; audit `EXPLOIT_FLAGGED` on first insert |
| `executeApproved` `CREDIT_REVIEW` | controller approval | `tier_change`: sets `client.tier` if still `from_tier` (else refused, audited), audit `TIER_CHANGED`; both actions add precedent `PRC-L<id>` (`source = 'live'`, Approved). Contract grace and cure stay as signed until renewal |
| `transition_work_item` → REJECTED | controller | precedent `PRC-L<id>`, Rejected, note as `override_reason` |

Sync keeps `client.tier` once imported, like `status`, so an approved change survives the next sync.

## Expected on the demo morning

9 tier changes (Meridian, Silverline 2→1; Harbor & Pine, Granite Bay, Larkspur, Quillon 3→2; Fieldstone 2→3; Orchard 3→5; Wrenfield 4→5), 1 review (Halcyon), 20 stay (Cobalt Ridge, Ostrava, Ember held by the margin; Kestrel by `recent_late`).

## Check it

```
cd agents && uv run pytest                  # answer key on tests/fixtures/book.json
pnpm credit:fixture                         # rebuild the fixture from the dataset
pnpm demo:reset && pnpm sync && pnpm agents # one cycle, then:
pnpm credit:verify                          # 30 profiles, 6 flags (+ Fieldstone after its lump sum), 10 open reviews
cd agents && uv run python -m desk_agents.credit dump /tmp/books.json   # live books in fixture shape
```
