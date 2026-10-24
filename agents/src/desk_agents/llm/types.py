"""What every provider speaks: a messages list in, a Reply out."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class Reply:
    text: str
    content: list[Any]  # replayed as the assistant turn on a retry
    provider: str = ""  # which provider answered ("anthropic", "factory")
    model: str = ""  # the model, when the provider says


Ask = Callable[[list[dict[str, Any]]], Reply]


class DecisionUnavailable(Exception):
    """The call could not produce an answer (timeout, refusal, cut off)."""
