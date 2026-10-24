"""The backtest replays past month-ends; on the fixture its headline numbers are stable."""

from datetime import date
from pathlib import Path

from desk_agents.credit.backtest import backtest, month_ends
from desk_agents.credit.load import load_books_from_json

FIXTURE = Path(__file__).parent / "fixtures" / "book.json"


def test_backtest_on_the_fixture():
    books = load_books_from_json(FIXTURE)
    r = backtest(books, month_ends(date(2025, 9, 1), books[0].today))
    assert r["cutoffs"][0] == "2025-09-30" and r["cutoffs"][-1] == "2026-02-28"
    assert r["exploits"]["caught"] == r["exploits"]["planted"]
    assert r["exploits"]["false_alarms"] == []
    # Better than "pays on the due date", and the tier separates good payers from bad.
    assert r["settle"]["mae_days"] < r["settle"]["naive_mae_days"]
    late = {int(k): v["late_share"] for k, v in r["tiers"]["calibration"].items()}
    assert late[1] < late[2] < late[3] and late[2] < late[5]
    assert r["tiers"]["downgrades"]["held"] == r["tiers"]["downgrades"]["n"] > 0
