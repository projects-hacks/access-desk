from datetime import date, timedelta
from typing import Any

from ..stdb import SpacetimeClient

Row = dict[str, Any]

CLIENT_FIELDS = ("id", "name", "segment", "tier", "strategic", "renewal_on", "status")
INVOICE_FIELDS = ("id", "client_id", "product", "period", "issued_on", "due_on", "amount_cents", "paid_cents",
                  "paid_on", "status")
MOVEMENT_FIELDS = ("id", "rail", "amount_cents", "value_on", "status", "match_status", "orig_name", "refs",
                   "is_history")


def pick(row: Row, fields: tuple[str, ...]) -> Row:
    return {k: row.get(k) for k in fields}


def take(db: SpacetimeClient, task: Row, family_refs: tuple[str, ...], draft_policy_id: str) -> dict[str, Any]:
    """Everything the harness reads, as of now: 12 months of money, the precedents and today's policies."""
    today = db.sql("SELECT * FROM clock")[0]["sim_date"]
    since = (date.fromisoformat(today) - timedelta(days=365)).isoformat()
    clauses: dict[str, dict[str, bool]] = {}
    for c in db.sql("SELECT * FROM contract_clause"):
        clauses.setdefault(c["client_id"], {})[c["kind"]] = bool(c["allowed"])
    contracts = {
        c["client_id"]: {
            "grace_days": c["grace_days"], "cure_days": c["cure_days"], "cross_default": c["cross_default"],
            "clauses": clauses.get(c["client_id"], {}),
        }
        for c in db.sql("SELECT * FROM contract")
    }
    invoices = [pick(i, INVOICE_FIELDS) for i in db.sql("SELECT * FROM invoice") if i["due_on"] >= since]
    movements = [
        pick(m, MOVEMENT_FIELDS) for m in db.sql("SELECT * FROM cash_movement")
        if m["direction"] == "in" and m["value_on"] >= since
    ]
    moved = {m["id"] for m in movements}
    applications = [
        {k: a[k] for k in ("movement_id", "invoice_id", "amount_cents", "reversed")}
        for a in db.sql("SELECT * FROM payment_application") if a["movement_id"] in moved
    ]
    policies = [
        p for p in db.sql("SELECT * FROM policy")
        if p["status"] == "active" or p["policy_id"] in family_refs or p["policy_id"] == draft_policy_id
    ]
    return {
        "task": {**task, "today": today, "windowFrom": since},
        "precedents": db.sql("SELECT * FROM precedent"),
        "clients": {c["id"]: pick(c, CLIENT_FIELDS) for c in db.sql("SELECT * FROM client")},
        "contracts": contracts,
        "invoices": invoices,
        "payments": {"movements": movements, "applications": applications},
        "positions": [
            {k: p.get(k) for k in ("client_id", "instrument", "side", "notional_cents", "hedge_group", "status")}
            for p in db.sql("SELECT * FROM position")
        ],
        "levers": [{k: lv[k] for k in ("client_id", "lever", "state")} for lv in db.sql("SELECT * FROM access_lever")],
        "capability": [{k: c[k] for k in ("lever", "step", "gentleness")} for c in db.sql("SELECT * FROM capability")],
        "policies": policies,
    }
