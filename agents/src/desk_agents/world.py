from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .config import settings
from .stdb import SpacetimeClient

Row = dict[str, Any]

PER_CLIENT = [
    "invoice", "dispute", "contract_clause", "access_lever", "hold", "custody_holding", "position",
    "work_item", "deadline", "payer_identity", "exploit_flag", "rm_note", "precedent",
    "access_request",
]


@dataclass
class ClientView:
    client: Row
    contract: Row | None = None
    invoice: list[Row] = field(default_factory=list)
    dispute: list[Row] = field(default_factory=list)
    contract_clause: list[Row] = field(default_factory=list)
    access_lever: list[Row] = field(default_factory=list)
    hold: list[Row] = field(default_factory=list)
    custody_holding: list[Row] = field(default_factory=list)
    position: list[Row] = field(default_factory=list)
    work_item: list[Row] = field(default_factory=list)
    deadline: list[Row] = field(default_factory=list)
    payer_identity: list[Row] = field(default_factory=list)
    exploit_flag: list[Row] = field(default_factory=list)
    rm_note: list[Row] = field(default_factory=list)
    precedent: list[Row] = field(default_factory=list)
    access_request: list[Row] = field(default_factory=list)
    cash: list[Row] = field(default_factory=list)
    in_transit: list[Row] = field(default_factory=list)
    rejections: list[Row] = field(default_factory=list)
    approvals: list[Row] = field(default_factory=list)
    withdrawals: list[Row] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.client["id"]


@dataclass
class World:
    today: str
    platform: Row
    capability: list[Row]
    clients: dict[str, ClientView]
    work_items: dict[int, Row]
    readings: dict[int, Any] = field(default_factory=dict)
    unplaced: list[Row] = field(default_factory=list)
    policies: list[Row] = field(default_factory=list)
    investigated: set[int] = field(default_factory=set)
    last_waits: dict[str, str] = field(default_factory=dict)
    failed_commands: dict[int, str] = field(default_factory=dict)
    changed: set[str] = field(default_factory=set)


DECISIONS = {"REJECTED": "rejections", "APPROVED": "approvals", "WITHDRAWN": "withdrawals"}


@dataclass
class AuditLog:
    """The audit rows the agent learns from, read incrementally. A reset wipes the table, so it starts over."""

    last_id: int = 0
    decisions: list[Row] = field(default_factory=list)
    waits: dict[str, str] = field(default_factory=dict)
    changed: set[str] = field(default_factory=set)

    def query(self) -> str:
        return f"SELECT * FROM audit_event WHERE id > {self.last_id}"

    def absorb(self, rows: list[Row]) -> None:
        self.changed = set()
        for row in sorted(rows, key=lambda r: r["id"]):
            self.last_id = max(self.last_id, row["id"])
            if row["action"] == "RESET_WORLD":
                self.decisions, self.waits = [], {}
            if row["client_id"]:
                self.changed.add(row["client_id"])
            if row["action"] == "AGENT_WAITED":
                self.waits[row["client_id"]] = row["detail"]
            elif row["to_state"] in DECISIONS and row["allowed"]:
                self.decisions.append(row)


def load_world(db: SpacetimeClient, audit: AuditLog | None = None) -> World:
    """Every table the agents read. Each query is a network round trip; Maincloud serves about four at once well."""
    audit = audit or AuditLog()
    queries = {
        "clock": "SELECT * FROM clock",
        "platform": "SELECT * FROM platform",
        "client": "SELECT * FROM client",
        "contract": "SELECT * FROM contract",
        "audit": audit.query(),
        "cash": "SELECT * FROM cash_movement WHERE is_history = false",
        "capability": "SELECT * FROM capability",
        "policy": "SELECT * FROM policy WHERE status = 'active'",
        "investigation": "SELECT * FROM investigation_step",
        "failed": "SELECT * FROM gateway_command WHERE status = 'failed'",
        **{table: f"SELECT * FROM {table}" for table in PER_CLIENT},
    }
    with ThreadPoolExecutor(max_workers=settings.stdb_parallel_requests) as pool:
        results = dict(zip(queries, pool.map(db.sql, queries.values()), strict=True))
    audit.absorb(results["audit"])

    views = {c["id"]: ClientView(client=c) for c in results["client"]}
    for row in results["contract"]:
        if row["client_id"] in views:
            views[row["client_id"]].contract = row

    work_items: dict[int, Row] = {}
    for table in PER_CLIENT:
        for row in results[table]:
            view = views.get(row["client_id"])
            if view:
                getattr(view, table).append(row)
            if table == "work_item":
                work_items[row["id"]] = row

    for row in audit.decisions:
        view = views.get(row["client_id"])
        item = work_items.get(row["work_item_id"] or -1)
        if view and item:
            getattr(view, DECISIONS[row["to_state"]]).append({**row, "work_item_kind": item["kind"]})

    incoming = [m for m in results["cash"] if m["direction"] == "in"]
    for view in views.values():
        view.cash = [m for m in incoming if paid_by(view, m)]
        view.in_transit = [m for m in view.cash if m["match_status"] == "in_transit"]
    claimed = {m["id"] for v in views.values() for m in v.cash}
    unplaced = [m for m in incoming
                if m["status"] == "posted" and m["match_status"] in ("unmatched", "exception") and m["id"] not in claimed]

    return World(
        today=results["clock"][0]["sim_date"],
        platform=results["platform"][0],
        capability=results["capability"],
        clients=views,
        work_items=work_items,
        unplaced=unplaced,
        policies=results["policy"],
        investigated={s["work_item_id"] for s in results["investigation"]},
        failed_commands={c["work_item_id"]: c["error"] or "" for c in results["failed"] if c["work_item_id"] is not None},
        last_waits=dict(audit.waits),
        changed=set(audit.changed),
    )


def paid_by(view: ClientView, movement: Row) -> bool:
    refs = set(movement.get("refs") or [])
    if view.id in refs or refs & {i["id"] for i in view.invoice}:
        return True
    names = {movement.get("orig_account", ""), movement.get("orig_name", "").casefold()}
    known = {p["value"] for p in view.payer_identity} | {p["value"].casefold() for p in view.payer_identity}
    known |= {view.client["name"].casefold(), view.client["legal_name"].casefold()}
    return bool((names - {""}) & known)
