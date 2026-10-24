import asyncio
import logging
import sys

from .agents.access_controller import AccessController, plan
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


def dry_run(db: SpacetimeClient) -> None:
    world = AccessController(db).observe()
    moves = plan(world)
    print(f"sim date {world.today} · {len(moves)} move(s)")
    for move in moves:
        print(f"\n{move.client_id} {world.clients[move.client_id].client['name']}: {move.action} · {move.summary}")
        for key, value in move.args.items():
            print(f"    {key}: {value}")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    db =SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    if sys.argv[1:] == ["plan"]:
        dry_run(db)
        db.close()
        return
    try:
        asyncio.run(loop([CreditAnalyst(db), AccessController(db)], db))
    except KeyboardInterrupt:
        pass
    finally:
        db.close()


if __name__ == "__main__":
    main()
