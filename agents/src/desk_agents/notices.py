import logging
import re

import anthropic

from .config import settings

log = logging.getLogger("desk_agents.notices")

SYSTEM = """You rewrite notices from an institutional crypto prime broker's collections desk so they read like a \
careful person wrote them. You get the facts as a draft.

Rules:
- Keep every amount, date, invoice number, wire reference, clause number and work item number exactly as written \
in the draft, character for character. Do not round, reformat or convert them.
- Add no number, date or identifier that is not in the draft.
- Keep every fact in the draft, including every amount and invoice number. Add no new facts or promises.
- Plain text, no greeting line, no signature, no placeholders. At most 120 words.

Reply with the notice text only."""

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


class Writer:
    """Claude words the notice; the template is used whenever Claude is unavailable or a number doesn't check out."""

    def __init__(self, client: anthropic.Anthropic | None = None):
        """No client means templates only; use Writer.from_settings() for Claude with the configured key."""
        self._client = client

    @classmethod
    def from_settings(cls) -> "Writer":
        return cls(anthropic.Anthropic(api_key=settings.anthropic_api_key) if settings.anthropic_api_key else None)

    def write(self, channel: str, body: str, context: str) -> tuple[str, bool]:
        """Returns the text to send and whether Claude wrote it."""
        if not self._client:
            return body, False
        tag = TAG.search(body)
        draft = body[: tag.start()] if tag else body
        try:
            rewrite = self._ask(channel, draft, context)
        except anthropic.APIError as e:
            log.warning("Claude could not word the notice, sending the template: %s", e)
            return body, False
        if not rewrite:
            return body, False
        problem = safe(draft, rewrite)
        if problem:
            log.warning("Claude's wording failed the number check (%s); sending the template", problem)
            return body, False
        return rewrite + (tag.group(0) if tag else ""), True

    def _ask(self, channel: str, draft: str, context: str) -> str | None:
        response = self._client.beta.messages.create(
            model=settings.anthropic_model,
            max_tokens=1024,
            system=SYSTEM,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{
                "role": "user",
                "content": f"Audience: {AUDIENCE.get(channel, channel)}\n{context}\n\n<draft>\n{draft}\n</draft>",
            }],
        )
        if response.stop_reason != "end_turn":
            log.warning("Claude stopped with %s while wording a notice; sending the template", response.stop_reason)
            return None
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        return text or None
