import json
from typing import Any

import httpx

from .decode import decode_rows
from .models import Proposal


class SpacetimeClient:
    """
    Minimal SpacetimeDB HTTP client. Agents read with SQL and write only by
    calling reducers; they never touch systems of record directly.
    """

    def __init__(self, base_url: str, database: str, token: str | None = None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._db = database
        self._http = httpx.Client(base_url=base_url, headers=headers, timeout=10)

    def sql(self, query: str) -> list[dict[str, Any]]:
        res = self._http.post(f"/v1/database/{self._db}/sql", content=query)
        _raise_for_status(res)
        return decode_rows(res.json()[0])

    def call(self, reducer: str, *args: Any) -> None:
        # Reducer names are snake_case on the wire (proposeWorkItem -> propose_work_item).
        res = self._http.post(f"/v1/database/{self._db}/call/{reducer}", json=list(args))
        _raise_for_status(res)

    def propose(self, p: Proposal) -> None:
        self.call(
            "propose_work_item",
            p.kind.value,
            p.client_id,
            p.subject_id,
            p.title,
            p.amount_cents,
            json.dumps(p.proposal),
            p.reasoning,
            p.policy_ref,
            p.clauses_cited,
            json.dumps(p.boundaries),
            p.confidence,
            p.required_role.value,
        )

    # ── Actions ────────────────────────────────────────────────────────────
    # Each reducer checks the contract, capabilities and policy before a work
    # item exists, and raises ReducerError with the reason when it refuses.
    # Approved (or auto-approved by policy) actions run through the gateway.

    def propose_custody_debit(
        self, client_id: str, invoice_ids: list[str], reasoning: str, policy_ref: str = "pol-005",
        confidence: float = 0.9,
    ) -> None:
        """Collect overdue invoices from custody cash. Empty invoice_ids = every overdue invoice."""
        self.call("propose_custody_debit", client_id, invoice_ids, reasoning, policy_ref, confidence)

    def propose_restriction(
        self, client_id: str, lever: str, step: str, reasoning: str, policy_ref: str, confidence: float = 0.9,
    ) -> None:
        """
        One step on one lever: withdrawals HOLD_AMOUNT_OWED, trading NO_NEW_POSITIONS,
        api RATE_LIMIT, financing NO_NEW_BORROWING, ... (see the capability table).
        Always needs a controller.
        """
        self.call("propose_restriction", client_id, lever, step, reasoning, policy_ref, confidence)

    def propose_restriction_with_boundaries(
        self, client_id: str, lever: str, step: str, reasoning: str, policy_ref: str, boundaries_json: str,
        confidence: float = 0.9,
    ) -> None:
        """propose_restriction plus structured context (e.g. the full-cutoff comparison) in boundaries_json."""
        self.call("propose_restriction_with_boundaries", client_id, lever, step, reasoning, policy_ref, confidence, boundaries_json)

    def propose_restore(
        self, client_id: str, lever: str, reasoning: str, policy_ref: str = "pol-011", confidence: float = 0.9,
    ) -> None:
        self.call("propose_restore", client_id, lever, reasoning, policy_ref, confidence)

    def propose_notice(
        self, client_id: str, channel: str, body: str, reasoning: str, policy_ref: str = "pol-007",
        confidence: float = 0.9,
    ) -> None:
        """channel: email | portal | rm"""
        self.call("propose_notice", client_id, channel, body, reasoning, policy_ref, confidence)

    def request_withdrawal(self, client_id: str, amount_cents: int) -> None:
        """A client withdrawal request (CLIENT for their own account, DEMO, CONTROLLER)."""
        self.call("request_custody_withdrawal", client_id, amount_cents)

    def set_deadline(self, client_id: str, kind: str, due_on: str, note: str, work_item_id: int | None = None) -> None:
        """kind: promise_to_pay | follow_up. Resolved automatically when the sim date reaches due_on."""
        self.call("set_deadline", client_id, kind, due_on, note, _option(work_item_id))

    def record_agent_run(
        self, agent: str, trigger: str, proposed: int, status: str, error: str | None, duration_ms: int,
    ) -> None:
        self.call("record_agent_run", agent, trigger, proposed, status, _option(error or None), duration_ms)

    def propose_payment_match(
        self, client_id: str, movement_id: str, reasoning: str, evidence_json: str, confidence: float,
        rm_note_id: int | None = None,
    ) -> None:
        """Attribute unplaced cash to a client with evidence; an accountant approves once."""
        self.call("propose_payment_match", movement_id, client_id, reasoning, evidence_json, confidence,
                  _option(rm_note_id))

    def record_wait(self, client_id: str, code: str, reason: str) -> None:
        """Audits a decision not to act on a client who owes money."""
        self.call("record_wait", client_id, code, reason)

    def record_investigation(self, work_item_id: int, steps: list[dict[str, str]]) -> None:
        """Steps are {tool, summary, status}, in the order the agent took them."""
        self.call("record_investigation", work_item_id, steps)

    def upsert_precedent(self, row: dict[str, Any]) -> None:
        """A decision worth learning from. `work_item_id` is optional: pass _option(id)."""
        self.call("upsert_precedent", row)

    def decide(self, work_item_id: int, to_state: str, note: str = "") -> None:
        """APPROVED | REJECTED | NEEDS_INFO | WITHDRAWN. Denied attempts are audited, not raised."""
        self.call("transition_work_item", work_item_id, to_state, note)

    # ── Credit analyst (seat 1) ────────────────────────────────────────────

    def upsert_credit_profile(
        self, client_id: str, value_score: int, reliability_score: int, coverage_ratio: float,
        coverage_detail: str, expected_settle_on: str | None,
    ) -> None:
        """Scores 0-100. Audited (CREDIT_SCORED) only when a score moves."""
        self.call(
            "upsert_credit_profile", client_id, value_score, reliability_score, coverage_ratio,
            coverage_detail, _option(expected_settle_on),
        )

    def upsert_exploit_flag(
        self, id: str, client_id: str, pattern: str, score: float, status: str, months: int,
        evidence_json: str, proposed_fix: str,
    ) -> None:
        """id = `<pattern>:<client_id>`. A row a controller set to `cleared` stays cleared."""
        self.call(
            "upsert_exploit_flag", id, client_id, pattern, score, status, months, evidence_json,
            proposed_fix,
        )

    def upsert_policy(
        self, policy_id: str, version: int, status: str, title: str, rule_json: str,
        learned_from: str, approved_by: str | None = None,
    ) -> None:
        """Agents may only write `draft` rows; a controller's approval activates them."""
        self.call(
            "upsert_policy", policy_id, version, status, title, rule_json, learned_from,
            _option(approved_by),
        )

    def record_policy_outcome(self, policy_key: str, outcome: str) -> None:
        """The evaluator's verdict on an active company policy, onto its live precedent."""
        self.call("record_policy_outcome", policy_key, outcome)

    # ── Reads ──────────────────────────────────────────────────────────────

    def fingerprint(self) -> tuple[int, str]:
        """Changes whenever anything is audited or the sim date moves: the cue for agents to look again."""
        audited = self.sql("SELECT COUNT(*) AS n FROM audit_event")[0]["n"]
        return audited, self.sql("SELECT * FROM clock")[0]["sim_date"]

    def open_work(self) -> list[dict[str, Any]]:
        """Work waiting on a person or an agent."""
        return self.sql("SELECT * FROM work_item WHERE state = 'PROPOSED' OR state = 'NEEDS_INFO'")

    def client_snapshot(self, client_id: str) -> dict[str, Any]:
        """Everything an agent needs to reason about one client."""
        cid = client_id.replace("'", "''")
        tables = [
            "invoice", "dispute", "contract", "contract_clause", "access_lever", "hold", "custody_holding",
            "position", "loan", "client_credit", "payer_identity", "credit_profile", "work_item", "access_request",
            "deadline", "notice",
        ]
        snap: dict[str, Any] = {"client": next(iter(self.sql(f"SELECT * FROM client WHERE id = '{cid}'")), None)}
        for table in tables:
            snap[table] = self.sql(f"SELECT * FROM {table} WHERE client_id = '{cid}'")
        snap["bank_account"] = self.sql(f"SELECT * FROM bank_account WHERE owner = '{cid}'")
        return snap

    def close(self) -> None:
        self._http.close()


def _option(value: Any) -> dict[str, Any]:
    """SATS-JSON for option<T>."""
    return {"none": []} if value is None else {"some": value}


class ReducerError(Exception):
    """A reducer refused the call (bad role, bad state). Nothing was written."""


def _raise_for_status(res: httpx.Response) -> None:
    if res.status_code == 530:
        raise ReducerError(res.text)
    res.raise_for_status()
