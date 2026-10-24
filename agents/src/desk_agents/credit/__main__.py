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

USAGE = ("usage: python -m desk_agents.credit dump <path> | backtest [books.json] [--json out.json]"
         " | eval-provider <anthropic|factory> [--cutoffs 2025-09-30,...] [--books books.json]"
         " [--price-in N --price-out N] [--json out.json]")


def _opt(args: list[str], name: str) -> str | None:
    i = args.index(name) + 1 if name in args else 0
    return args[i] if 0 < i < len(args) else None


def eval_provider(args: list[str]) -> int:
    from .evalprovider import DEFAULT_PRICES, evaluate_provider, write_json
    from .evalprovider import render as render_eval

    if not args or args[0].startswith("--"):
        sys.exit(USAGE)
    provider = args[0]
    from ..llm import get_ask  # lazy: the provider layer lives in another module

    usage: list = []
    ask = get_ask(provider, usage)
    if ask is None:
        print(f"provider '{provider}' is not available (no API key, or the droid CLI is "
              "missing); nothing was called.")
        return 2
    books_path, out, cut = _opt(args, "--books"), _opt(args, "--json"), _opt(args, "--cutoffs")
    books = load_books_from_json(books_path) if books_path else live_books()
    tier_then = {} if books_path else tiers_before_today()
    cutoffs = ([date.fromisoformat(c) for c in cut.split(",")] if cut
               else month_ends(date(2025, 9, 1), books[0].today))
    p_in, p_out = _opt(args, "--price-in"), _opt(args, "--price-out")
    prices = ({"input": float(p_in), "output": float(p_out)} if p_in and p_out
              else DEFAULT_PRICES if provider == "anthropic" else None)
    result = evaluate_provider(books, cutoffs, ask, tier_then=tier_then, usage=usage,
                               prices=prices, provider=provider)
    print(render_eval(result))
    if out:
        write_json(result, out)
        print(f"\n-> {out}")
    return 0 if result["passed"] else 1


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
    elif args and args[0] == "eval-provider":
        sys.exit(eval_provider(args[1:]))
    else:
        sys.exit(USAGE)


if __name__ == "__main__":
    main()
