from ..models import Proposal
from .base import Agent


class CreditAnalyst(Agent):
    """Scores clients (value, reliability, coverage); assigns tiers and per-product limits."""

    name = "credit-analyst"

    async def run(self) -> list[Proposal]:
        # TODO: read clients + invoices via self.db.sql(...), score, return CREDIT_REVIEW proposals.
        return []
