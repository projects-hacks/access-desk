from ..models import Proposal
from .base import Agent


class AccessController(Agent):
    """Recover first, restrict the unpaid product first, gentlest step first; restore on payment."""

    name = "access-controller"

    async def run(self) -> list[Proposal]:
        # TODO: find overdue exposure, pick the next restriction step the contract allows,
        # return RESTRICTION / RESTORE proposals.
        return []
