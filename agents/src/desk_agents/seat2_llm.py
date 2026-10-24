"""
Seat 2's language-model calls, through the same providers as Seat 1 (`desk_agents.llm`).

Each feature has its own order: the RM-note classifier is on the critical path of the
"already paid" moment, so it asks Claude first; notices are not, so they ask Factory first.
A provider that is unavailable (no key, no droid CLI) is skipped; one that fails, times out
or returns something our checks reject hands over to the next. With none left, the caller
falls back to keywords or the template.
"""

import logging
from collections.abc import Callable
from typing import Any

from .config import settings
from .llm import BUILDERS
from .llm.types import Ask

log = logging.getLogger("desk_agents.seat2_llm")

LABELS = {"anthropic": "Claude", "factory": "Factory (Droid)", "keywords": "keyword rules"}


def label(provider: str) -> str:
    return LABELS.get(provider, provider)


def chain(order: str, schema: dict[str, Any], timeouts: dict[str, float]) -> list[tuple[str, Ask]]:
    """The available providers for one feature, in its configured order."""
    out = []
    for name in dict.fromkeys(p.strip() for p in order.split(",")):
        build = BUILDERS.get(name)
        ask = build(schema=schema, timeout=timeouts.get(name)) if build else None
        if ask is not None:
            out.append((name, ask))
    return out


def first_good(asks: list[tuple[str, Ask]], messages: list[dict[str, Any]], accept: Callable[[str], Any], what: str,
               ) -> tuple[Any, str] | None:
    """The first provider whose answer `accept` takes (it raises or returns None to reject), and who it was."""
    for name, ask in asks:
        try:
            result = accept(ask(messages).text)
        except Exception as e:  # noqa: BLE001 - any failure hands the call to the next provider
            log.warning("%s could not %s: %s", label(name), what, e)
            continue
        if result is not None:
            return result, name
        log.warning("%s's answer to %s was rejected by our checks", label(name), what)
    return None


def rm_note_order() -> str:
    return settings.seat2_rm_note_providers


def notice_order() -> str:
    return settings.seat2_notice_providers
