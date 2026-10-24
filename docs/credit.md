# Credit analyst (seat 1)

Scores every client, reads the exploit flags, and proposes tier changes on the platform's 1–5 scale (1 best) and company-specific policies. Claude makes the per-company decision; the deterministic rules are its evidence, its guardrails and its fallback (see [Claude decisions](#claude-decisions-guardrails-and-company-policies)). It never restricts a lever, holds cash, debits custody, approves its own work, activates a policy, changes a strategic client's tier or edits contract terms. Plan: [seat1-build-plan.pdf](seat1-build-plan.pdf).

Code: `agents/src/desk_agents/credit/` (pure: `scoring.py`, `detectors.py`, `tiers.py`, `guardrails.py`, `company.py`; `decide.py` asks Claude; `load.py` reads the database; `reasoning.py` is the rules' paragraph) and `agents/credit_analyst.py` (the 15 s loop). Today is always `clock.sim_date`; `load.py` cuts every book to it, so nothing dated later is read and a replay at an earlier date is honest.

## Scores (`credit_profile`)

Invoices that count: past due, not void, not under an open dispute. Lag = `paid_on − due_on` (open: today − due). dpd = max(0, lag). Weight = 0.5^(age/90).

| Score | Rule |
|---|---|
| Reliability 0–100 | 100 − lateness (0.8 × weighted mean dpd, cap 35) − frequency (20 × weighted share dpd > 10) − severity (15 if worst dpd in 180 days > 60, 8 if > 30) − paid in pieces (4 × weighted count with 2+ payments, cap 10) − disputes lost (1.5 per `no_change`, `credited` free, cap 15); then (m × raw + 3 × 70)/(m + 3), m = months scored |
| Value 0–100 | 75 × log of fees billed in 365 days, scaled smallest → largest client, + 25 × products / 4 |
| Coverage ratio | (USD custody if the §6.3 debit clause is signed + owed to client) ÷ undisputed unpaid; `coverage_detail` adds §7.2 holdable custody as a multiple of exposure |
| Expected settle | oldest open undisputed invoice's due date + weighted median lag (today if earlier) |

## Exploit detectors (`exploit_flag`, id `<pattern>:<client_id>`)

The ExploitWatch agent owns every `exploit_flag` write and `EXPLOIT_FLAG` item. The credit analyst reads the table (rows not `cleared`) as guardrail inputs and evidence; for a client with no rows at all it runs the detectors below itself, so the fixture tests and a fresh database still work. A `cleared` row means no flag for that pattern, even if the detector would fire.

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

## Tiers (the rules' baseline)

This is the deterministic decision. It goes to Claude as `baseline` and is used as is when Claude isn't asked, has no key, fails, or breaks the guardrails twice.

Base from reliability: ≥ 85 → 2, ≥ 70 → 3, ≥ 55 → 4, else 5. Value ≥ 75 lifts one tier (tier 1 needs reliability ≥ 85). Any flag caps at tier 3. Then, in order:

1. Strategic: never a tier change; a worse formula tier becomes a `review` (pol-022).
2. Upgrade: one step, only if reliability clears its band line by 3+ and `recent_late` didn't fire (pol-021).
3. Downgrade: up to two steps (pol-020).
4. No duplicates. Each item records the rules' view of the client (`view`: the baseline's subject, or `stay:<client>`). While a client has an open item (PROPOSED / NEEDS_INFO / APPROVED / POSTED) recorded under the current view, or one rejected under it less than 30 sim days ago, nothing new is proposed and Claude isn't asked. A new view withdraws the client's open review (PROPOSED / NEEDS_INFO) and the client is decided again.

Confidence 0.7 within 5 points of a band line (55, 70, 85), else 0.9.

`CREDIT_REVIEW`: subject `tier:<client>:<from>-><to>` or `review:<client>`, title "Orchard Treasury: tier 3 → 5", amount = undisputed exposure, `proposal_json` {action, from_tier, to_tier, reliability, value, coverage_ratio, breakdown, flags, expected_settle_on, decided_by, why, view, baseline, choice, guardrails, rejected_attempts}, required role CONTROLLER. Reasoning is Claude's reasons plus the cited invoices and what the rules alone would do, or the template when the rules decided.

## Claude decisions, guardrails and company policies

Scores, flags and history stay deterministic: they are the evidence. Claude (`settings.anthropic_model`, effort low, 45 s timeout, no SDK retries) picks the decision for each company; `guardrails.py` decides whether it may reach a controller; a controller still approves every tier change and every policy.

**Who is asked.** Only companies where something is happening: the baseline proposes a change or review, a flag fired, or one of the company's active policies is failing its success criteria. On the fixture that is 13 of 30 (10 baseline proposals + Kestrel, Juniper, Monarch). Calls run 6 at a time; a decision is remembered per client until its facts change (a new sim day, a payment), so the 15 s loop doesn't re-ask. Outages aren't remembered.

**What Claude gets** (`decide.py` `facts`, inside `<facts>` and labelled data): today; client (tier, strategic, renewal); contract and clauses; scores with breakdown, coverage, exposure, settle date; fired flags with measured strings and evidence invoice ids; payment history (summary: mean days late and share within grace for the last 6 months vs before, median lag per product, restriction day; every invoice with due, paid, days late, number of payments; disputes); the baseline (action, to_tier, formula tier, policy, reasons); the credit policies pol-020..022; this company's own policy versions and their evaluations; this company's live precedents with outcomes; the guardrail list and the client-specific limits in words.

**What Claude returns** (structured output, `output_config.format` with the JSON schema of `guardrails.Decision`; parsed with pydantic):

```
{ action: "stay" | "tier_change" | "review",
  to_tier: int,
  policy: null | { kind: "existing" | "company_draft", policy_id, title,
                   terms: [{ lever: prepay | custody_debit | cross_default | grace_days | cure_days | reminder,
                             value: int | null, at_renewal: bool }],
                   success_criteria: [{ metric: share_paid_within_grace | mean_days_late | max_days_late | pattern_not_firing,
                                        target: number, pattern: string | null, window_months: int }] },
  reasons: [string], cited_invoice_ids: [string], confidence: number }
```

**Guardrails** (`guardrails.GUARDRAILS`, sent in the prompt; `violations()` checks them):

| id | Limit |
|---|---|
| tier_range, action_shape | tier 1..5; stay and review keep the tier, tier_change moves it |
| max_down, max_up | at most 2 steps worse, 1 step better per proposal |
| strategic | strategic client: never a tier change, review only |
| recent_late | no upgrade while recent_late fired |
| flag_cap | any fired flag: a tier change no better than tier 3 |
| lever_prepay, lever_debit | prepay only with an allowed `prepay` clause; custody debit only with an allowed `debit` clause |
| lever_cross_default | renewal term only, and not if already signed |
| lever_grace, lever_cure, lever_reminder, lever_value | grace 0–15 and cure 5–15 days, renewal terms only; reminder 1–10 days before due; value null for the others |
| policy_exists, draft_shape, one_open_draft | `existing` cites an active policy with no new terms; a draft is `pol-020/021/022` or `<base>:<this client>`, with a title, 1+ terms, 1+ criteria; one open draft per client |
| criteria | share 0..1, days 0..90, known pattern, window 1..12 months |
| citations | every cited invoice is in the client's book; a tier change or draft cites at least one |
| confidence, reasons | 0..1; at least one reason |

The 3-point upgrade margin is no longer a limit: it shows in the baseline's reasons, and Claude may weigh it.

**Retry and fallback.** A reply that isn't valid JSON for the schema, or breaks a guardrail, gets one retry with the problems listed (the earlier reply stays in the conversation). A second failure, any API error, refusal or truncation, or no `ANTHROPIC_API_KEY` → the baseline, `decided_by: "rules"`. With no key the analyst reproduces the answer key exactly.

**Company policies.** A `company_draft` becomes a `policy` row `pol-020:ORG-90677@<version>`, status `draft`, via `upsert_policy` (`rule_json` {client_id, base, terms, success_criteria, proposed_on}; `learned_from` = Claude's reasons and the cited invoices), and a `POLICY_DRAFT` work item (subject `policy:<key>`, required role CONTROLLER, `proposal_json` {policy_key, policy_id, version, title, rule, decided_by, baseline, choice, guardrails, ...}). Versions count up; an unapproved draft is overwritten. Agents may only save `draft` rows and never over a version past draft (`upsert_policy` refuses).

| On | Module does |
|---|---|
| POLICY_DRAFT approved | `activatePolicyDraft`: draft → `active`, `rule_json` gains `effective_on` (sim date) and `work_item_id`, `approvedBy` = the controller; the previous active version of the same policy id → `superseded`. Audit `POLICY_ACTIVATED` / `POLICY_SUPERSEDED`; precedent `PRC-L<id>` Approved. A draft that is gone or no longer a draft is refused quietly (audited, `allowed = false`) |
| POLICY_DRAFT rejected | draft → `rejected`, audit `POLICY_REJECTED`; precedent Rejected with the note |
| `record_policy_outcome(policyKey, outcome)` (AGENT, ADMIN) | stores the evaluator's verdict on the activating precedent's `outcome`; audit `POLICY_OUTCOME` when the verdict (passing / failing) changes |

**The learning loop.** Each run, `company.evaluate` (pure) checks every active company policy against the book: invoices due from `effective_on` through `window_months`, counted once their grace has passed; fewer than 2 → `pending`. `share_paid_within_grace` passes at ≥ target, `mean_days_late` / `max_days_late` at ≤ target, `pattern_not_firing` when that detector doesn't fire on those invoices. A verdict goes to `record_policy_outcome` ("failing on 2026-03-03: 0 of 8 paid within 5 days (0.00 vs >= 0.8)"). A failing policy makes the company eligible for a Claude call even if nothing else is happening, and the failing results are in its facts, so Claude can propose a better version of the same policy (which supersedes it on approval) or a tier change. Precedents with their outcomes are in the facts too.

The Credit screen shows on every review and draft: decided by Claude or the rules, Claude's choice next to the baseline, why it was asked, terms and success criteria, the guardrails that applied and any rejected attempts; the client panel lists its company policy versions with status, effective date and outcome.

## Reducers

| Reducer | Who | Does |
|---|---|---|
| `upsert_credit_profile` | AGENT, ADMIN | upsert by client; audit `CREDIT_SCORED` only when a score moves |
| `upsert_exploit_flag` | AGENT, ADMIN | upsert by id, keeps `cleared`; audit `EXPLOIT_FLAGGED` on first insert (written by ExploitWatch) |
| `upsert_policy` | AGENT (drafts only), CONTROLLER, ADMIN | upsert by `<policyId>@<version>`; audit `POLICY_SAVED` |
| `executeApproved` `POLICY_DRAFT` | controller approval | activates the draft, supersedes the previous active version (see above) |
| `record_policy_outcome` | AGENT, ADMIN | evaluator verdict onto the activating precedent |
| `executeApproved` `CREDIT_REVIEW` | controller approval | `tier_change`: sets `client.tier` if still `from_tier` (else refused, audited), audit `TIER_CHANGED`; both actions add precedent `PRC-L<id>` (`source = 'live'`, Approved). Contract grace and cure stay as signed until renewal |
| `transition_work_item` → REJECTED | controller | precedent `PRC-L<id>`, Rejected, note as `override_reason` |

Sync keeps `client.tier` once imported, like `status`, so an approved change survives the next sync.

## Expected on the demo morning

9 tier changes (Meridian, Silverline 2→1; Harbor & Pine, Granite Bay, Larkspur, Quillon 3→2; Fieldstone 2→3; Orchard 3→5; Wrenfield 4→5), 1 review (Halcyon), 20 stay (Cobalt Ridge, Ostrava, Ember held by the margin; Kestrel by `recent_late`).

On the live database payment checking has already applied two things the fixture leaves unapplied: Fieldstone's Mar 2 lump sum (`recent_late` fires, still 2→3) and Saltmarsh's Feb 19 wire for January (reliability ~75, so 4→3: 10 changes and 11 open reviews). `credit:verify` expects both once their invoices are paid.

## Who approves

The module decides this itself in `propose_work_item` (`spacetime/src/autonomy.ts`), from the client in the database, so an agent can't talk its way past it.

| Client | What the credit agents propose |
|---|---|
| Strategic (the hand-marked top 0.1%) | Always waits for a controller: tier changes, reviews, exploit alerts |
| Everyone else, any tier, confidence at least 0.1 | Applies at once (item created `APPROVED`, `auto_applied`, audited `AUTO_APPLIED`): tier changes, reviews, exploit alerts acknowledged |

Below confidence 0.1 (`MIN_AUTO_CONFIDENCE`) any proposal waits for a controller, except exploit alerts. Company policy drafts also wait when a term moves money or changes the contract (`custody_debit`, `cross_default`). A `tier_change` with an unreadable target tier is never applied.

The limits are named constants at the top of `autonomy.ts`. The guardrails and the 30-day rejection memory apply as before; rejecting or approving by hand is only for what waits. `credit:verify` checks that nothing for a tier 1 or 2 client auto-applied and that the worst cases waited.

## Check it

```
cd agents && uv run pytest                  # answer key on tests/fixtures/book.json
pnpm credit:fixture                         # rebuild the fixture from the dataset
pnpm demo:reset && pnpm sync && pnpm agents # one cycle, then:
pnpm credit:verify                          # 30 profiles, 6 flags (+ Fieldstone; written by ExploitWatch now), 10 open reviews (+ Saltmarsh)
cd agents && uv run python -m desk_agents.credit dump /tmp/books.json   # live books in fixture shape
```
