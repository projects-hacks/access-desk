import argparse
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
    if not log_runs or (trigger != "startup" and not acted and status == "ok"):
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


def rm_note(db: SpacetimeClient, client_id: str, text: str, author: str, work_item_id: int | None) -> int:
    """Records what an RM says for a client, as the demo identity. Returns a process exit code."""
    try:
        db.call("add_rm_note", client_id, author, text, {"some": work_item_id} if work_item_id is not None else {"none": []})
    except ReducerError as e:
        print(f"refused: {e}")
        return 1
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            print("add_rm_note is not published in this database yet (pnpm stdb:publish, then pnpm stdb:generate)")
        else:
            print(f"failed: {e}")
        return 1
    print(f"RM note recorded for {client_id}; the access controller picks it up within a second or two")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="desk-agents", description="Credit analyst and access controller agents.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="run the agents (default)")
    sub.add_parser("plan", help="print what the access controller would do, without calling reducers")
    note = sub.add_parser("rm-note", help="record what a relationship manager says about a client")
    note.add_argument("client_id", help="e.g. ORG-90412")
    note.add_argument("text", help='e.g. "They already paid, wire sent Monday"')
    note.add_argument("--author", default="", help="the RM's name (default: the client's RM)")
    note.add_argument("--work-item", type=int, default=None, help="the work item the note is about, if any")
    return parser.parse_args(argv)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    args = parse_args(sys.argv[1:])
    if args.command == "rm-note":
        if not settings.stdb_demo_token:
            sys.exit("STDB_DEMO_TOKEN is not set in .env")
        demo = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_demo_token)
        try:
            sys.exit(rm_note(demo, args.client_id, args.text, args.author, args.work_item))
        finally:
            demo.close()
    db = SpacetimeClient(settings.stdb_http_url, settings.stdb_database, settings.stdb_agent_token)
    if args.command == "plan":
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
