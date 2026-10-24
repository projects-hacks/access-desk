"""python -m desk_agents.credit dump <path>   writes the live books to JSON (fixture shape)."""

import sys

from ..config import settings
from ..stdb import SpacetimeClient
from .load import dump_books, load_books


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] != "dump":
        sys.exit("usage: python -m desk_agents.credit dump <path>")
    db = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    try:
        books = load_books(db)
    finally:
        db.close()
    dump_books(books, sys.argv[2])
    print(f"{len(books)} clients on {books[0].today if books else '-'} -> {sys.argv[2]}")


if __name__ == "__main__":
    main()
