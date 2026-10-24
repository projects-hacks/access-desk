"""Pluggable LLM providers behind one `Ask`. Default is the Claude API."""

from collections.abc import Callable
from typing import Any

from ..config import settings
from .anthropic_ask import claude_ask
from .factory import factory_ask
from .types import Ask, DecisionUnavailable, Reply

BUILDERS: dict[str, Callable[..., Ask | None]] = {"anthropic": claude_ask, "factory": factory_ask}


def provider_chain() -> list[str]:
    """The configured provider, then each fallback in order (unknown names dropped)."""
    names = [settings.llm_provider, *(p.strip() for p in settings.llm_fallback.split(","))]
    return [n for i, n in enumerate(names) if n in BUILDERS and n not in names[:i]]


def get_ask(provider: str | None = None, usage: list[Any] | None = None,
            **opts: Any) -> Ask | None:
    """
    One Ask for the provider, or (with none given) for the whole chain: a provider that
    raises hands the call to the next, and only when all fail does the error propagate.
    Providers that are unavailable (no key, no droid) are skipped; none left means None.
    `opts` (schema, timeout, max_tokens) go to each provider.
    """
    names = [provider] if provider else provider_chain()
    asks = [a for n in names if (a := BUILDERS[n](usage=usage, **opts)) is not None]
    if not asks:
        return None
    if len(asks) == 1:
        return asks[0]

    def ask(messages: list[dict[str, Any]]) -> Reply:
        last: Exception | None = None
        for a in asks:
            try:
                return a(messages)
            except Exception as e:  # noqa: BLE001 (any failure hands over to the next)
                last = e
        assert last is not None
        raise last

    return ask


__all__ = ["Ask", "DecisionUnavailable", "Reply", "claude_ask", "factory_ask", "get_ask",
           "provider_chain"]
