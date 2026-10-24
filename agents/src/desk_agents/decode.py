"""Decodes SpacetimeDB's SQL-over-HTTP values using the schema it returns."""

from datetime import UTC, datetime
from typing import Any

TIMESTAMP = "__timestamp_micros_since_unix_epoch__"
IDENTITY = "__identity__"


def _name(element: dict) -> str | None:
    return element.get("name", {}).get("some")


def decode(value: Any, algebraic_type: dict) -> Any:
    """Option -> value or None, timestamp -> datetime, identity -> hex str, product -> dict."""
    ((kind, spec),) = algebraic_type.items()
    if kind == "Sum":
        variants = spec["variants"]
        names = [_name(v) for v in variants]
        tag, inner = value
        if names == ["some", "none"]:
            return None if tag == 1 else decode(inner, variants[0]["algebraic_type"])
        return {"tag": names[tag], "value": decode(inner, variants[tag]["algebraic_type"])}
    if kind == "Product":
        elements = spec["elements"]
        if len(elements) == 1 and _name(elements[0]) == TIMESTAMP:
            return datetime.fromtimestamp(value[0] / 1_000_000, tz=UTC)
        if len(elements) == 1 and _name(elements[0]) == IDENTITY:
            return value[0]
        return {
            _name(e): decode(v, e["algebraic_type"]) for e, v in zip(elements, value, strict=True)
        }
    if kind == "Array":
        return [decode(v, spec) for v in value]
    return value


def decode_rows(result: dict) -> list[dict[str, Any]]:
    elements = result["schema"]["elements"]
    return [
        {_name(e): decode(v, e["algebraic_type"]) for e, v in zip(elements, row, strict=True)}
        for row in result["rows"]
    ]
