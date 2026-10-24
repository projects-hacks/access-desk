import asyncio
import logging

from .agents.access_controller import AccessController
from .agents.base import Agent
from .agents.credit_analyst import CreditAnalyst
from .config import settings
from .stdb import SpacetimeClient

log = logging.getLogger("desk_agents")


async def loop(agents: list[Agent], db: SpacetimeClient) -> None:
    # TODO: react to table changes instead of polling.
    while True:
        for agent in agents:
            try:
                for proposal in await agent.run():
                    db.propose(proposal)
                    log.info(
                        "[%s] proposed %s for %s", agent.name, proposal.kind, proposal.client_id
                    )
            except Exception:
                log.exception("[%s] run failed", agent.name)
        await asyncio.sleep(settings.agent_interval_seconds)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    try:
        asyncio.run(loop([CreditAnalyst(db), AccessController(db)], db))
    except KeyboardInterrupt:
        pass
    finally:
        db.close()


if __name__ == "__main__":
    main()
