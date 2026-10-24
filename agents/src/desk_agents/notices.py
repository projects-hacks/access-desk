import json
import logging
import re

from .config import settings
from .llm.types import Ask
from .seat2_llm import chain, first_good, notice_order

log = logging.getLogger("desk_agents.notices")

SYSTEM = """You rewrite notices from an institutional crypto prime broker's collections desk so they read like a \
careful person wrote them. You get the facts as a draft.

Rules:
- Keep every amount, date, invoice number, wire reference, clause number and work item number exactly as written \
in the draft, character for character. Do not round, reformat or convert them.
- Add no number, date or identifier that is not in the draft.
- Keep every fact in the draft, including every amount and invoice number. Add no new facts or promises.
- Plain text, no greeting line, no signature, no placeholders. At most 120 words.
"""

AUDIENCE = {
    "email": "the client's finance team, by email",
    "portal": "the client, in the client portal",
    "rm": "the client's relationship manager (an internal colleague)",
}
TAG = re.compile(r"\s*\((?:ref WI|re RM)-\d+\)\s*$")
TOKEN = re.compile(r"[\w$.,\-/:]*\d[\w$.,\-/:]*")
REQUIRED = re.compile(r"^(\$[\d,]+\.\d{2}|INV-\d+)$")


def tokens(text: str) -> set[str]:
    """Every word that carries a digit (amounts, dates, ids, references), without trailing punctuation."""
    return {t.rstrip(".,:;-") for t in TOKEN.findall(text)} - {""}


def safe(draft: str, rewrite: str) -> str | None:
    """Why the rewrite can't be used, or None. Numbers must come from the draft; amounts and invoices must stay."""
    allowed, used = tokens(draft), tokens(rewrite)
    invented = sorted(used - allowed)
    if invented:
        return f"numbers not in the facts: {', '.join(invented)}"
    dropped = sorted(t for t in allowed if REQUIRED.match(t) and t not in used)
    if dropped:
        return f"dropped from the facts: {', '.join(dropped)}"
    return None


TEXT_SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string", "description": "The notice text only"}},
    "required": ["text"],
    "additionalProperties": False,
}


class Writer:
    """A provider words the notice; the template is used when none is available or no wording passes the check."""

    def __init__(self, asks: list[tuple[str, Ask]] | None = None):
        """No providers means templates only; Writer.from_settings() uses Seat 2's notice order."""
        self._asks = asks or []

    @classmethod
    def from_settings(cls) -> "Writer":
        return cls(chain(notice_order(), TEXT_SCHEMA, {"factory": settings.seat2_factory_timeout_seconds}))

    def write(self, channel: str, body: str, context: str) -> tuple[str, str]:
        """Returns the text to send and which provider wrote it ("" for the template)."""
        if not self._asks:
            return body, ""
        tag = TAG.search(body)
        draft = body[: tag.start()] if tag else body
        messages = [{
            "role": "user",
            "content": f"{SYSTEM}\n\nAudience: {AUDIENCE.get(channel, channel)}\n{context}\n\n<draft>\n{draft}\n</draft>\n\n"
                       'Answer as JSON: {"text": "<the notice>"}.',
        }]

        def accept(raw: str) -> str:
            text = json.loads(raw)["text"].strip()
            problem = safe(draft, text)
            if problem:
                raise ValueError(f"number check failed ({problem})")
            return text

        got = first_good(self._asks, messages, accept, "word the notice")
        if got is None:
            return body, ""
        text, provider = got
        return text + (tag.group(0) if tag else ""), provider
