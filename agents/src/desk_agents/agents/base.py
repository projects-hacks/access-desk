from abc import ABC, abstractmethod

from ..models import Proposal
from ..stdb import SpacetimeClient


class Agent(ABC):
    """Reads golden state, returns proposals. Never writes to systems of record."""

    name: str

    def __init__(self, db: SpacetimeClient):
        self.db = db

    @abstractmethod
    async def run(self) -> list[Proposal]: ...
