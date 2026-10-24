from dataclasses import dataclass, field
from typing import Any

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
    policies: list[Row] = field(default_factory=list)
    investigated: set[int] = field(default_factory=set)


def load_world(db: SpacetimeClient) -> World:
    clock = db.sql("SELECT * FROM clock")[0]
    platform = db.sql("SELECT * FROM platform")[0]
    views = {c["id"]: ClientView(client=c) for c in db.sql("SELECT * FROM client")}
    for row in db.sql("SELECT * FROM contract"):
        if row["client_id"] in views:
            views[row["client_id"]].contract = row

    work_items: dict[int, Row] = {}
    for table in PER_CLIENT:
        for row in db.sql(f"SELECT * FROM {table}"):
            view = views.get(row["client_id"])
            if view:
                getattr(view, table).append(row)
            if table == "work_item":
                work_items[row["id"]] = row

    for state, target in (("REJECTED", "rejections"), ("APPROVED", "approvals")):
        for row in db.sql(f"SELECT * FROM audit_event WHERE to_state = '{state}'"):
            view = views.get(row["client_id"])
            item = work_items.get(row["work_item_id"] or -1)
            if view and item and row["allowed"]:
                getattr(view, target).append({**row, "work_item_kind": item["kind"]})

    incoming = [m for m in db.sql("SELECT * FROM cash_movement WHERE is_history = false") if m["direction"] == "in"]
    for view in views.values():
        view.cash = [m for m in incoming if paid_by(view, m)]
        view.in_transit = [m for m in view.cash if m["match_status"] == "in_transit"]

    return World(
        today=clock["sim_date"],
        platform=platform,
        capability=db.sql("SELECT * FROM capability"),
        clients=views,
        work_items=work_items,
        policies=db.sql("SELECT * FROM policy WHERE status = 'active'"),
        investigated={s["work_item_id"] for s in db.sql("SELECT * FROM investigation_step")},
    )


def paid_by(view: ClientView, movement: Row) -> bool:
    refs = set(movement.get("refs") or [])
    if view.id in refs or refs & {i["id"] for i in view.invoice}:
        return True
    names = {movement.get("orig_account", ""), movement.get("orig_name", "").casefold()}
    known = {p["value"] for p in view.payer_identity} | {p["value"].casefold() for p in view.payer_identity}
    known |= {view.client["name"].casefold(), view.client["legal_name"].casefold()}
    return bool((names - {""}) & known)
