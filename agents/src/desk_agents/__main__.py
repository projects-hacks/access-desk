import asyncio
import logging
import sys
import time

import httpx

from .agents.access_controller import AccessController, plan
from .agents.base import Agent
from .agents.credit_analyst import CreditAnalyst
from .config import settings
from .stdb import ReducerError, SpacetimeClient

log = logging.getLogger("desk_agents")


async def loop(agents: list[Agent], db: SpacetimeClient) -> None:
    """Run every agent when the database changes, and at least every agent_interval_seconds."""
    seen: tuple[int, str] | None = None
    last_run = 0.0
    log_runs = True
    while True:
        try:
            now = db.fingerprint()
        except Exception:
            log.exception("could not read the database fingerprint")
            await asyncio.sleep(settings.agent_interval_seconds)
            continue
        idle = time.monotonic() - last_run >= settings.agent_interval_seconds
        if now != seen or idle:
            trigger = "startup" if seen is None else "interval" if now == seen else f"change · audit #{now[0]} · {now[1]}"
            for agent in agents:
                log_runs = await run_once(agent, db, trigger, log_runs)
            seen, last_run = now, time.monotonic()
        await asyncio.sleep(settings.watch_seconds)


async def run_once(agent: Agent, db: SpacetimeClient, trigger: str, log_runs: bool) -> bool:
    started = time.monotonic()
    acted, status, error = 0, "ok", None
    try:
        for proposal in await agent.run():
            db.propose(proposal)
            acted += 1
            log.info("[%s] proposed %s for %s", agent.name, proposal.kind, proposal.client_id)
        acted += getattr(agent, "acted", 0)
    except Exception as e:
        status, error = "error", f"{type(e).__name__}: {e}"[:500]
        log.exception("[%s] run failed", agent.name)
    if not log_runs or (trigger == "interval" and not acted and status == "ok"):
        return log_runs
    try:
        db.record_agent_run(agent.name, trigger, acted, status, error, int((time.monotonic() - started) * 1000))
    except (ReducerError, httpx.HTTPError) as e:
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 404:
            log.warning("record_agent_run is not published in this database yet; not recording runs")
            return False
        log.warning("[%s] could not record the run: %s", agent.name, e)
    return True


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
