# Schema (v1 draft)

The SpacetimeDB module in `spacetime/` is the system of work. Business rules live in its reducers; outside services only feed it data or act on what it approves.

## Conventions

- `*_cents`: i64 integer cents. Never floats for money.
- `*_on`, `date`: `'YYYY-MM-DD'` in the simulated world, compared against `clock.sim_date`.
- `*_at`: real timestamp.
- `*_json`: JSON string. States and kinds are strings, validated in reducers.
- IDs are stable text from the source (`ORG-90412`, `INV-1021`, `nessie:<_id>`).
- Derived values aren't stored: days past due, aging, unpaid totals, autonomy %, exposure.
- Every write that changes state appends to `audit_event` in the same reducer.
- Fields the system of work owns (client status, lever state, loan borrowing, match status, paid amounts) come from sync on first import only.

## Ownership

Rajeev owns the schema and is the only one who publishes. Others change fields or reducers in a PR; reducers live in per-area files (`reducers/<area>.ts`). Breaking changes wipe the shared database, so announce them first. Schema freezes Saturday ~2 PM.

## Core tables (38)

**World**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `platform` | id=1, name, legal_name, wire_instructions, auto_apply_limit_cents | owner | header, portal, notices, settings |
| `clock` | id=1, sim_date, updated_at | demo control (+7 days) | everything |
| `actor` | identity, name, role, client_id? | admin | role checks, role switcher |

**Sync**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `sync_source` | source, label, status, record_count, cursor, last_sync_at, error | sync | onboarding, "last sync" |
| `raw_record` | id (`source:external_id`), source, hash, payload_json, first_seen_at, last_seen_at, golden_table, golden_id | sync | "why?" lineage |

**Clients and access**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `client` | id, name, legal_name, segment, tier, strategic, relationship_manager, renewal_on, status | sync; status: gateway | clients list, everywhere |
| `payer_identity` | id, client_id, kind (bank_account / wallet / name_alias / affiliate), value, label, relation, verified | sync; accountant confirms | payment checking |
| `contract` | client_id, msa_ref, terms_days, grace_days, cure_days, cross_default | sync | seat 2, contract panel |
| `contract_clause` | id, client_id, clause, kind (set_off / debit / cure / no_forced_close / change_of_control / prepay), allowed, text | sync | proposals, portal |
| `capability` | id, product, lever, step, gentleness, reversible, two_approvers, adapter_action | owner | allowed actions = capability ∩ clauses |
| `access_lever` | id (`client:lever`), client_id, lever (withdrawals / trading / api / financing), state (active / limited / off / not_used), detail, work_item_id | gateway | W/T/A/F chips, before/after, portal |

**Money**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `invoice` | id, client_id, product, label, period, issued_on, due_on, amount_cents, source_paid_cents, paid_cents, paid_on, status (open / partially_paid / paid / disputed / void) | sync; paid_cents and status: payment checking | aging, seats 1–2, invoice lists |
| `dispute` | id, invoice_id, client_id, amount_cents, reason, opened_on, status, owner | sync, RM | proposals exclude it |
| `cash_movement` | id, source (nessie / chain), platform_account, direction, rail (WIRE / ACH / USDC / BOOK), amount_cents, value_on, status (pending / posted / cancelled / returned), memo, orig_name, orig_account, refs, bank_ref, reverses, raw_id, match_status, is_history | sync; match_status: payment checking | payments tab, ticker |
| `payment_application` | id, movement_id, invoice_id, amount_cents, method (exact / referenced / split / short_fee / alias / account / overpay_credit / reversal), policy_ref, work_item_id, reversed | payment checking | invoice status, tie-out, audit |
| `client_credit` | id, client_id, kind (unapplied_cash / overpayment / prepay), amount_cents, movement_id | payment checking, gateway | recover-first, prepay |
| `ledger_entry` | id (`journal:line`), journal_id, posted_on, account_code, debit_cents, credit_cents, ref, memo, source (billing / treasury / access-desk), work_item_id | sync (GL), gateway write-through | tie-out, "why?" |

**Assets and exposure**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `custody_holding` | id (`client:asset`), client_id, asset, quantity, value_cents | sync | coverage, custody panel |
| `asset_price` | asset, price_cents, as_of | sync | valuation |
| `hold` | id, client_id, amount_cents, reason, clause, invoice_ids (secured), work_item_id, status (active / released), created_at, released_at | gateway; released by payment checking | portal withdrawal, release |
| `owed_to_client` | id, client_id, kind (staking_rewards / rebate / unsettled_proceeds), amount_cents, as_of | sync | netting |
| `position` | id, client_id, instrument, side, notional_cents, hedge_group, status | sync | hedge protection, exposure |
| `loan` | id, client_id, line_cents, outstanding_cents, status, borrowing_allowed | sync; borrowing_allowed: gateway | financing panel |

**Work**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `work_item` | id, kind, client_id, subject_id, state, title, amount_cents, proposal_json, reasoning, policy_ref, clauses_cited, boundaries_json, confidence, auto_applied, required_role, proposed_by, revision, revised_from, expires_on, created_at, updated_at | agents; state: state machine | "needs you", proposal drawer, ticker |
| `decision` | id, work_item_id, revision, decided_by, role, decision (approve / reject / request_info), reason_code, note, at | people | revise loop, precedents |
| `investigation_step` | id, work_item_id, seq, tool, summary, status | agents | novel case |
| `rm_note` | id, client_id, work_item_id?, author, text, at | RM | proposals, novel case |
| `notice` | id, client_id, work_item_id, channel (email / portal / rm), body, status (draft / sent), sent_at | gateway | notice preview, reminders |
| `gateway_command` | id, key (idempotency), type, work_item_id, action_json, status (queued / executing / done / failed), result_json, external_ref, attempts, error, created_at, updated_at | reducers queue; gateway claims and completes | audit, tie-out, retries |
| `access_request` | id, client_id, action (withdraw / trade / borrow / api), amount_cents, decision, allowed_cents, held_cents, reason, at | access-check route | portal, audit |
| `deadline` | id, kind (cure_end / promise / renewal_recheck), client_id, work_item_id, due_on, status | reducers | clock advance |
| `agent_run` | id, agent, trigger, started_at, finished_at, proposed, status, error | agents | "agent live", autonomy % |

**Learning**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `credit_profile` | client_id, value_score, reliability_score, coverage_ratio, coverage_detail, expected_settle_on, updated_at | credit analyst | client profile, clients list |
| `policy` | key (`pol-014@2`), policy_id, version, status (draft / active / retired), title, rule_json, learned_from, approved_by | agents draft; controller activates | policies, every citation |
| `precedent` | id, client_id, work_item_id?, decided_on, situation, proposed, decision, override_reason, outcome, policy_ref, source (history / live) | sync (history), agents (live) | policy drafting, replay |
| `metric_snapshot` | id, week_ending, metric, value | sync (history), agents | trend charts |
| `exploit_flag` | id, client_id, pattern, score, status (flagged / watch / cleared), months, evidence_json, proposed_fix | exploit sub-agent | exploits screen |

**Audit**

| Table | Fields | Written by | Read by |
|---|---|---|---|
| `audit_event` | id, at, sim_date, actor, actor_role, actor_name, action, subject_type, subject_id, client_id, work_item_id, from_state, to_state, allowed, detail, policy_ref | every reducer | audit log, "why?", ticker |

| `tie_out_run`, `tie_out_break` | run: sim_date, trigger, status (tied / explained / break), unexplained_cents, summary_json · break: run_id, area, kind, amount_cents, ref, detail | tie-out reducer | books status, controller |

## Next priority

`payment_promise`, `tier_default`, `client_contact`, `incident`, `payment_intent`, `usage_record`

## If time allows

`policy_replay`, `scoreboard_run`, `tier_change`, `credit_limit`

## Logic that lives in the module

These are what make SpacetimeDB the core rather than a side database:

- `upsert_cash_movement` → payment checking → applications → hold release → audit, in one transaction ([payments.md](payments.md))
- `transition_work_item`: state machine, role checks, no self-approval, denied attempts logged
- `advance_clock`: moves the shared date and fires due `deadline`s
- HTTP route `access-check`: the platform asks before a withdrawal or trade; the decision is computed next to the data
