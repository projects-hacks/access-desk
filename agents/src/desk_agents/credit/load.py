"""
Builds a ClientBook per client from the shared database (whole tables, joined
here) or from a JSON fixture, then cuts it to `today` so nothing dated later is
ever read. A replay at an earlier date sees the books as they stood then.
"""

import json
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Protocol

from .model import ClientBook, Dispute, Invoice

TABLES = [
    "client", "contract", "contract_clause", "invoice", "payment_application", "cash_movement",
    "dispute", "custody_holding", "owed_to_client", "clock",
]


class Sql(Protocol):
    def sql(self, query: str) -> list[dict[str, Any]]: ...


def load_books(db: Sql, today: date | None = None) -> list[ClientBook]:
    rows = {t: db.sql(f"SELECT * FROM {t}") for t in TABLES}
    sim_date = date.fromisoformat(rows["clock"][0]["sim_date"])
    return books_from_rows(rows, today or sim_date)


def books_from_rows(rows: dict[str, list[dict[str, Any]]], today: date) -> list[ClientBook]:
    by_client: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for table in ["contract_clause", "invoice", "dispute", "custody_holding", "owed_to_client"]:
        for r in rows[table]:
            by_client[r["client_id"]][table].append(r)
    contracts = {r["client_id"]: r for r in rows["contract"]}
    value_on = {m["id"]: m["value_on"] for m in rows["cash_movement"]}
    paid_on = {i["id"]: i["paid_on"] for i in rows["invoice"]}
    payments: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for a in sorted(rows["payment_application"], key=lambda a: a["id"]):
        if a["reversed"]:
            continue
        # Custody debits have no cash movement; they settle on the invoice's paid date.
        on = value_on.get(a["movement_id"]) or paid_on.get(a["invoice_id"])
        if on:
            payments[a["invoice_id"]].append({"value_on": on, "amount_cents": a["amount_cents"]})

    books = []
    for c in sorted(rows["client"], key=lambda c: c["id"]):
        own = by_client[c["id"]]
        k = contracts.get(c["id"])
        books.append({
            "client": c,
            "contract": k or {"terms_days": 30, "grace_days": 5, "cure_days": 10,
                              "cross_default": False},
            "clauses": own["contract_clause"],
            "invoices": [{**i, "payments": _merge(payments[i["id"]])} for i in own["invoice"]],
            "disputes": own["dispute"],
            "custody": own["custody_holding"],
            "owed_to_client_cents": sum(o["amount_cents"] for o in own["owed_to_client"]),
        })
    return [cut(ClientBook.model_validate({**b, "today": today}), today) for b in books]


def _merge(payments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Several applications of one cash movement on one invoice are one payment."""
    out: dict[str, int] = {}
    for p in payments:
        out[p["value_on"]] = out.get(p["value_on"], 0) + p["amount_cents"]
    return [{"value_on": d, "amount_cents": a} for d, a in sorted(out.items())]


def cut(book: ClientBook, today: date) -> ClientBook:
    """The book as it stood on `today`: later invoices, payments and dispute rulings removed."""
    invoices = []
    for inv in book.invoices:
        if inv.issued_on > today:
            continue
        kept = [p for p in inv.payments if p.value_on <= today]
        dropped = sum(p.amount_cents for p in inv.payments if p.value_on > today)
        paid = max(0, inv.paid_cents - dropped)
        paid_on = inv.paid_on if inv.paid_on and inv.paid_on <= today else None
        invoices.append(inv.model_copy(update={
            "payments": kept, "paid_cents": paid, "paid_on": paid_on,
            "status": _status(inv, paid, paid_on),
        }))
    disputes = []
    for d in book.disputes:
        if d.opened_on > today:
            continue
        if d.resolved_on and d.resolved_on > today:
            d = Dispute(id=d.id, invoice_id=d.invoice_id, opened_on=d.opened_on,
                        status="under_review")
        disputes.append(d)
    # Only a dispute still open on `today` marks an unpaid invoice disputed.
    disputed = {d.invoice_id for d in disputes if d.status == "under_review"}
    for n, i in enumerate(invoices):
        if i.id in disputed and i.status != "paid":
            invoices[n] = i.model_copy(update={"status": "disputed"})
    return book.model_copy(update={"invoices": invoices, "disputes": disputes, "today": today})


def _status(inv: Invoice, paid: int, paid_on: date | None) -> str:
    if inv.status == "void":
        return "void"
    if paid >= inv.amount_cents and paid_on:
        return "paid"
    return "partially_paid" if paid > 0 else "open"


def load_books_from_json(path: str | Path, today: date | None = None) -> list[ClientBook]:
    data = json.loads(Path(path).read_text())
    when = today or date.fromisoformat(data["today"])
    return [cut(ClientBook.model_validate({**b, "today": data["today"]}), when)
            for b in data["books"]]


def dump_books(books: list[ClientBook], path: str | Path) -> None:
    today = books[0].today.isoformat() if books else None
    data = {"today": today, "books": [b.model_dump(mode="json", exclude={"today"}) for b in books]}
    Path(path).write_text(json.dumps(data, indent=1) + "\n")
