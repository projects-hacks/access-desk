# Agent actions

Agents decide; these reducers are how they act. Each one checks the contract, the platform's capabilities and policy before a work item exists, and refuses with the reason (`SenderError`) otherwise. Approved actions run through the gateway, so every effect lands in the platform, the bank and the books.

| Reducer (wire name) | Args | Checks | On approval |
|---|---|---|---|
| `propose_custody_debit` | client_id, invoice_ids (empty = all overdue), reasoning, policy_ref, confidence | debit clause signed (§6.3), invoices overdue and undisputed, USD custody covers them | applications (`custody_debit`), `CUSTODY_DEBIT`, journal `JE-CD-n` (Dr 2100 / Cr 1200), holds released if cured |
| `propose_restriction` | client_id, lever, step, reasoning, policy_ref, confidence | lever in contract, step in `capability`, something overdue, cure period over (§9.1), set-off clause for withdrawals, cross-default for levers without overdue invoices, no close-only on a hedged book (pol-008) | withdrawals `HOLD_AMOUNT_OWED` → hold of the undisputed overdue amount + `PLACE_HOLD`; `FULL_FREEZE` → withdrawals off (and requests refused); other steps → `SET_LEVER` |
| `propose_restore` | client_id, lever, reasoning, policy_ref, confidence | lever currently restricted | holds released / lever active |
| `propose_notice` | client_id, channel (email / portal / rm), body, reasoning, policy_ref, confidence | non-empty body | `notice` row + `SEND_NOTICE`; marked sent on completion |
| `set_deadline` | client_id, kind (promise_to_pay / follow_up), due_on, note, work_item_id? | date after today | resolved automatically when the date comes: `met`, `broken` or `due` |
| `request_custody_withdrawal` | client_id, amount_cents | CLIENT (own account), DEMO, CONTROLLER, ADMIN | immediate: available = USD custody − active holds − withdrawals in flight; `access_request` row (approved / partial / denied); `CUSTODY_WITHDRAWAL` for the allowed part |

Callers: AGENT, CONTROLLER, ADMIN. Generic proposals (credit reviews, novel cases, policy drafts) still use `propose_work_item`.

## Time

The sim date moves by `advance_clock(days)` or on its own: `set_clock_speed(secondsPerDay, runUntil?)` (0 pauses), driven by the scheduled reducer `tick_clock` every second. Each sim day:

- deadlines due resolve: a cure period becomes `expired` (still in default) or `met`, a promise `broken` or `met`;
- clients newly past their grace period get a default notice (pol-007); once sent it starts the cure period (`contract.cure_days`);
- paying what was in default closes open cure periods and promises at once.

Restrictions need an expired cure period. Disputes count from the day they were filed: a dispute filed after the notice still takes those invoices out of default when the cure period ends (Orchard, the serial disputer, ends `met` with nothing paid; spotting that is the agents' job).

A withdrawal during a running cure period is honored (§9.1), but if it leaves custody cash below the amount in default the module raises an `EXPLOIT_FLAG` work item for the controller and an `exploit_flag` row (`withdrawal_during_cure`) with the evidence. The tick also requeues gateway commands stuck executing for 60s. Demo: `POST /demo/clock {secondsPerDay, runUntil}`.

## Who approves

- **Automatically**, whenever the kind's policy is active, the client is not strategic and the agent's confidence is at least 0.1 (`MIN_AUTO_CONFIDENCE`, `spacetime/src/autonomy.ts`): restrictions (pol-006), custody debits (pol-005, any amount), restores (pol-011), notices (pol-007). The item is created APPROVED with `auto_applied = true`.
- **A controller** only for the top clients (strategic, the hand-marked top 0.1%), proposals below the confidence threshold, and offboarding: capabilities with `two_approvers` (close-only, full freeze; titled "Offboarding: …") and a console permission change that turns off every permission the client has.
- **Credit proposals** (tier changes, reviews, exploit alerts) follow the same line: strategic clients and low confidence wait, everyone else applies at once (exploit alerts never wait on confidence). See [credit](credit.md#who-approves).
- `transition_work_item` enforces: approvers are ACCOUNTANT or CONTROLLER, `required_role = CONTROLLER` items need a controller, no one approves their own proposal. Denied attempts are audited, not thrown.
- APPROVED → POSTED happens when the gateway has confirmed every command.

## Web

Reads need no token: subscribe to the tables. Approvals call `transition_work_item` as the window's controller seat: Controller A (`VITE_STDB_CONTROLLER_TOKEN`) or Controller B (`VITE_STDB_CONTROLLER_B_TOKEN`), picked with `?as=a` / `?as=b`. Agents propose and either seat approves; what a seat proposes itself (console tier and permission changes on strategic clients, or an offboarding) needs the other seat. The portal's withdraw button is `POST /demo/withdraw {clientId, amount}` (dollars): it returns the decision, released and held amounts, and the Nessie wire once it's back through the feed.

## Python

`agents/src/desk_agents/stdb.py`: `propose_custody_debit`, `propose_restriction`, `propose_restore`, `propose_notice`, `request_withdrawal`, `decide`, plus `open_work()` and `client_snapshot(client_id)` (every table for one client). Refusals raise `ReducerError` with the reason.

## Check it

```
pnpm demo:reset && pnpm actions:verify    # then pnpm demo:reset again
```

Covers: Kestrel debit refused (§6.3) · Bluefin $22,400 auto-debited, bill completed at Nessie · $64,000 waits for a controller, agent can't approve · close-only refused on a hedged book · $148,200 hold · no self-approval · Kestrel asks $50,000: $26,000 wired (`CW-0001` through Nessie and back through the feed), $24,000 held · notice sent · restore · tie-out clean.
