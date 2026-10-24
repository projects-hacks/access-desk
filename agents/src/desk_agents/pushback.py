import logging
import re
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

from .config import settings

log = logging.getLogger("desk_agents.pushback")

SYSTEM = """You read notes a relationship manager (RM) at an institutional crypto prime broker writes about a client \
whose account may be restricted for unpaid fees. Classify what the RM is asking for.

- already_paid: the RM says the client has paid or sent a wire (even partially), so restrictions may be unnecessary.
- exception_request: the RM asks to hold off, grant a grace period, not freeze, or otherwise make an exception.
- other: anything else (context, questions, updates that ask for nothing).

If a note does both, prefer already_paid: a payment claim can be checked against the bank feed right away.
Extract only what the note states; leave a field null rather than guessing. Dates are YYYY-MM-DD; resolve relative \
dates ("Friday", "end of month") against today's date given in the message."""


class RmReading(BaseModel):
    intent: Literal["already_paid", "exception_request", "other"]
    summary: str = Field(description="One sentence, what the RM is saying")
    claimed_amount_usd: float | None = None
    payment_reference: str | None = Field(None, description="Wire reference, IMAD, TRN or invoice ids the RM quotes")
    grace_until: str | None = Field(None, description="Date the RM asks to hold off until")
    reason: str | None = Field(None, description="Why the RM says an exception is warranted")


class Reader:
    def __init__(self) -> None:
        self._client = anthropic.Anthropic(api_key=settings.anthropic_api_key) if settings.anthropic_api_key else None

    def read(self, note: str, client_name: str, today: str) -> RmReading:
        if self._client:
            try:
                return self._ask_claude(note, client_name, today)
            except anthropic.APIError as e:
                log.warning("Claude could not read the RM note, using keywords: %s", e)
        return by_keywords(note)

    def _ask_claude(self, note: str, client_name: str, today: str) -> RmReading:
        response = self._client.beta.messages.parse(
            model=settings.anthropic_model,
            max_tokens=2048,
            system=SYSTEM,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": f"Today: {today}\nClient: {client_name}\nRM note:\n{note}"}],
            output_format=RmReading,
        )
        if response.stop_reason == "refusal" or response.parsed_output is None:
            log.warning("Claude declined to read the RM note (%s), using keywords", response.stop_reason)
            return by_keywords(note)
        return response.parsed_output


PAID = re.compile(r"\b(paid|wired?|sent|remitted|payment (went|is) out|in transit|mt103|imad|trn)\b", re.IGNORECASE)
EXCEPTION = re.compile(r"\b(don'?t|do not|hold off|grace|extension|exception|pause|wait|until|strategic)\b", re.IGNORECASE)
AMOUNT = re.compile(r"\$\s?([\d,]+(?:\.\d{2})?)")
DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
REFERENCE = re.compile(r"\b(?:IMAD|TRN|ref(?:erence)?)\b[:#\s]*([A-Z0-9-]{6,})", re.IGNORECASE)


def by_keywords(note: str) -> RmReading:
    amount = AMOUNT.search(note)
    date = DATE.search(note)
    ref = REFERENCE.search(note)
    intent = "already_paid" if PAID.search(note) else "exception_request" if EXCEPTION.search(note) else "other"
    return RmReading(
        intent=intent,
        summary=note.strip()[:200],
        claimed_amount_usd=float(amount.group(1).replace(",", "")) if amount else None,
        payment_reference=ref.group(1) if ref else None,
        grace_until=date.group(1) if date and intent == "exception_request" else None,
        reason=note.strip()[:200] if intent == "exception_request" else None,
    )
