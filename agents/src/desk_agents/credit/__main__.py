"""
python -m desk_agents.credit dump <path>                     live books to JSON (fixture shape)
python -m desk_agents.credit backtest [books.json] [--json out.json]
    replay past month-ends and score the engine against what happened
    (default: the live database; or a dump / tests/fixtures/book.json)
"""

import json
import sys
from datetime import date

from ..config import settings
from ..stdb import SpacetimeClient
from .backtest import backtest, month_ends, render
from .load import dump_books, load_books, load_books_from_json

USAGE = "usage: python -m desk_agents.credit dump <path> | backtest [books.json] [--json out.json]"


def live_books():
    db = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    try:
        return load_books(db)
    finally:
        db.close()


def tiers_before_today() -> dict[str, int]:
    """Each client's tier before any approved change (first TIER_CHANGED's from_state)."""
    db = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    try:
        events = sorted(db.sql("SELECT * FROM audit_event"), key=lambda a: a["id"])
    finally:
        db.close()
    out: dict[str, int] = {}
    for a in events:
        if a["action"] == "TIER_CHANGED" and a["allowed"] and a["client_id"] not in out:
            out[a["client_id"]] = int(a["from_state"])
    return out


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "dump":
        books = live_books()
        dump_books(books, args[1])
        print(f"{len(books)} clients on {books[0].today if books else '-'} -> {args[1]}")
    elif args and args[0] == "backtest":
        out = args[args.index("--json") + 1] if "--json" in args else None
        rest = [a for a in args[1:] if a != "--json" and a != out]
        books = load_books_from_json(rest[0]) if rest else live_books()
        tier_then = {} if rest else tiers_before_today()
        today = books[0].today
        result = backtest(books, month_ends(date(2025, 9, 1), today), tier_then)
        print(render(result))
        if out:
            with open(out, "w") as f:
                json.dump(result, f, indent=1)
            print(f"\n-> {out}")
    else:
        sys.exit(USAGE)


if __name__ == "__main__":
    main()
