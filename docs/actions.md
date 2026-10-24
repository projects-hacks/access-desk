# Agent actions

Agents decide; these reducers are how they act. Each one checks the contract, the platform's capabilities and policy before a work item exists, and refuses with the reason (`SenderError`) otherwise. Approved actions run through the gateway, so every effect lands in the platform, the bank and the books.

| Reducer (wire name) | Args | Checks | On approval |
|---|---|---|---|
| `propose_custody_debit` | client_id, invoice_ids (empty = all overdue), reasoning, policy_ref, confidence | debit clause signed (§6.3), invoices overdue and undisputed, USD custody covers them | applications (`custody_debit`), `CUSTODY_DEBIT`, journal `JE-CD-n` (Dr 2100 / Cr 1200), holds released if cured |
| `propose_restriction` | client_id, lever, step, reasoning, policy_ref, confidence | lever in contract, step in `capability`, something overdue, set-off clause for withdrawals, cross-default for levers without overdue invoices, no full freeze, no close-only on a hedged book (pol-008) | withdrawals `HOLD_AMOUNT_OWED` → hold of the undisputed overdue amount + `PLACE_HOLD`; other steps → `SET_LEVER` |
| `propose_restore` | client_id, lever, reasoning, policy_ref, confidence | lever currently restricted | holds released / lever active |
| `propose_notice` | client_id, channel (email / portal / rm), body, reasoning, policy_ref, confidence | non-empty body | `notice` row + `SEND_NOTICE`; marked sent on completion |
| `request_custody_withdrawal` | client_id, amount_cents | CLIENT (own account), DEMO, CONTROLLER, ADMIN | immediate: available = USD custody − active holds − withdrawals in flight; `access_request` row (approved / partial / denied); `CUSTODY_WITHDRAWAL` for the allowed part |

Callers: AGENT, CONTROLLER, ADMIN. Generic proposals (credit reviews, novel cases, policy drafts) still use `propose_work_item`.

## Who approves

- **Automatically**, when the kind's policy is active and the amount is within `platform.auto_apply_limit_cents` ($50,000) and the client is not Tier 1 or strategic: custody debits (pol-005), restores (pol-011), notices (pol-007). The item is created APPROVED with `auto_applied = true`.
- **A controller**, for everything else. Restrictions never auto-apply.
- `transition_work_item` enforces: approvers are ACCOUNTANT or CONTROLLER, `required_role = CONTROLLER` items need a controller, no one approves their own proposal. Denied attempts are audited, not thrown.
- APPROVED → POSTED happens when the gateway has confirmed every command.

## Python

`agents/src/desk_agents/stdb.py`: `propose_custody_debit`, `propose_restriction`, `propose_restore`, `propose_notice`, `request_withdrawal`, `decide`, plus `open_work()` and `client_snapshot(client_id)` (every table for one client). Refusals raise `ReducerError` with the reason.

## Check it

```
pnpm demo:reset && pnpm actions:verify    # then pnpm demo:reset again
```

Covers: Kestrel debit refused (§6.3) · Bluefin $22,400 auto-debited, bill completed at Nessie · $64,000 waits for a controller, agent can't approve · close-only refused on a hedged book · $148,200 hold · no self-approval · Kestrel asks $50,000: $26,000 wired (`CW-0001` through Nessie and back through the feed), $24,000 held · notice sent · restore · tie-out clean.
