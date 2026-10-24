"""
Factory's Droid as the model behind a decision. One short-lived `droid exec` session per
call, locked down: no tools, no permissions granted, an empty temp directory. Python still
validates whatever comes back; this only supplies the text.
"""

import asyncio
import json
import re
import shutil
import tempfile
from collections.abc import Callable, Coroutine
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

from ..config import settings
from .types import Ask, DecisionUnavailable, Reply

MACHINE_ID = "access-desk"
RETRY_NOTE = "Your previous answer was rejected. Answer the original request again, fixing this:"


def _load_sdk() -> SimpleNamespace | None:
    """The droid_sdk members used here, or None when the SDK can't be imported."""
    try:
        from droid_sdk.client import DroidClient
        from droid_sdk.schemas.enums import AutonomyLevel, ReasoningEffort
        from droid_sdk.stream import AssistantTextDelta, ErrorEvent, TurnComplete
    except Exception:  # noqa: BLE001 (missing or broken install: fall back)
        return None
    return SimpleNamespace(
        DroidClient=DroidClient, AutonomyLevel=AutonomyLevel, ReasoningEffort=ReasoningEffort,
        AssistantTextDelta=AssistantTextDelta, ErrorEvent=ErrorEvent, TurnComplete=TurnComplete,
    )


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        t = b.get("text") if isinstance(b, dict) else getattr(b, "text", None)
        if t:
            parts.append(t)
    return "".join(parts)


def flatten(messages: list[dict[str, Any]]) -> str:
    """
    One prompt from the messages list; no session state is carried. The first message is
    the request; later user turns (rejection notes on a retry) are appended after it.
    """
    first, *rest = messages
    out = _text_of(first["content"])
    for m in rest:
        if m["role"] == "user":
            out += f"\n\n{RETRY_NOTE}\n{_text_of(m['content'])}"
    return out


def _clean(text: str) -> str:
    t = text.strip()
    m = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", t, re.DOTALL)
    return m.group(1) if m else t


async def _session(sdk: SimpleNamespace, prompt: str, schema: dict[str, Any], cwd: str,
                   usage: list[Any] | None) -> str:
    client = sdk.DroidClient(
        exec_path="droid", cwd=cwd, env={"FACTORY_API_KEY": settings.factory_api_key or ""},
    )
    chunks: list[str] = []
    errors: list[str] = []

    async def collect() -> None:
        async for msg in client.receive_response():
            if isinstance(msg, sdk.AssistantTextDelta):
                chunks.append(msg.text)
            elif isinstance(msg, sdk.ErrorEvent):
                errors.append(msg.message)
            elif isinstance(msg, sdk.TurnComplete):
                if usage is not None and msg.token_usage is not None:
                    usage.append(msg.token_usage)
                return

    reader: asyncio.Future[None] | None = None
    try:
        await client.connect()
        # receive_response subscribes on its first step: start it before sending the message.
        reader = asyncio.ensure_future(collect())
        await asyncio.sleep(0)
        await client.initialize_session(
            machine_id=MACHINE_ID,
            cwd=cwd,
            model_id=settings.factory_model or None,
            autonomy_level=sdk.AutonomyLevel.Off,
            reasoning_effort=sdk.ReasoningEffort.Low,
            restrict_tool_ids=[],
            disable_builtin_skills=True,
            auto_reject_permission_requests=True,
        )
        await client.add_user_message(
            text=prompt, output_format={"type": "json_schema", "schema": schema},
        )
        await reader
    finally:
        if reader is not None and not reader.done():
            reader.cancel()
        await client.close()
    if errors:
        raise DecisionUnavailable(f"droid error: {errors[0][:200]}")
    return "".join(chunks)


def _run(make: Callable[[], Coroutine[Any, Any, str]]) -> str:
    """asyncio.run, in a worker thread, or in a fresh one if a loop is running here."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(make())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(make())).result()


def factory_ask(
    usage: list[Any] | None = None,
    schema: dict[str, Any] | None = None,
    timeout: float | None = None,
    max_tokens: int | None = None,  # unused: Droid sets its own output limit
) -> Ask | None:
    """Droid-backed call, or None when droid isn't installed, has no key, or has no SDK."""
    if not settings.factory_api_key or shutil.which("droid") is None:
        return None
    sdk = _load_sdk()
    if sdk is None:
        return None
    limit = timeout if timeout is not None else settings.factory_timeout_seconds

    def ask(messages: list[dict[str, Any]]) -> Reply:
        from ..credit import guardrails as g

        prompt = flatten(messages)
        sch = schema if schema is not None else g.Decision.model_json_schema()
        cwd = tempfile.mkdtemp(prefix="desk-droid-")
        try:
            text = _run(lambda: asyncio.wait_for(_session(sdk, prompt, sch, cwd, usage), limit))
        except TimeoutError as e:
            raise DecisionUnavailable(f"droid timed out after {limit:g}s") from e
        finally:
            shutil.rmtree(cwd, ignore_errors=True)
        text = _clean(text)
        if not text:
            raise DecisionUnavailable("droid returned no answer")
        try:
            json.loads(text)
        except ValueError as e:
            raise DecisionUnavailable("droid answer was not JSON") from e
        return Reply(text, [{"type": "text", "text": text}], provider="factory",
                     model=settings.factory_model)

    return ask
