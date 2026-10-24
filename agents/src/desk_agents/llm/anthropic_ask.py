from typing import Any

import anthropic

from ..config import settings
from .types import Ask, DecisionUnavailable, Reply

TIMEOUT_SECONDS = 45.0
MAX_TOKENS = 8000


def default_schema() -> dict[str, Any]:
    from ..credit import guardrails as g

    return anthropic.transform_schema(g.Decision)


def claude_ask(
    usage: list[Any] | None = None,
    schema: dict[str, Any] | None = None,
    timeout: float = TIMEOUT_SECONDS,
    max_tokens: int = MAX_TOKENS,
) -> Ask | None:
    """
    The Claude API call, or None with no key (then every decision falls back to the rules).
    `usage` collects each response's token usage (the backtest reports its cost).
    """
    if not settings.anthropic_api_key:
        return None
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=timeout,
                                 max_retries=0)
    fmt = {"type": "json_schema", "schema": schema if schema is not None else default_schema()}

    def ask(messages: list[dict[str, Any]]) -> Reply:
        r = client.messages.create(
            model=settings.anthropic_model, max_tokens=max_tokens, messages=messages,
            output_config={"effort": "low", "format": fmt},
        )
        if usage is not None:
            usage.append(r.usage)
        if r.stop_reason != "end_turn":
            raise DecisionUnavailable(f"stop_reason {r.stop_reason}")
        return Reply("".join(b.text for b in r.content if b.type == "text"), list(r.content),
                     provider="anthropic", model=settings.anthropic_model)

    return ask
