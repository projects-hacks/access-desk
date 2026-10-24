"""
The Droid-backed call, against a fake droid_sdk. Nothing here starts droid or touches the
network: `droid` on PATH and the SDK are both faked.
"""

import asyncio
import json
import os
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest

from desk_agents.config import settings
from desk_agents.llm import factory
from desk_agents.llm.types import DecisionUnavailable

ANSWER = json.dumps({"action": "stay", "to_tier": 2})


@dataclass(frozen=True)
class Delta:
    text: str


@dataclass(frozen=True)
class Err:
    message: str


@dataclass(frozen=True)
class Done:
    token_usage: Any = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


class Level:
    Off = "off"


class Effort:
    Low = "low"


class FakeClient:
    """Records every call; replays `script` as the event stream (or hangs if told to)."""

    script: ClassVar[list[Any]] = []
    hang = False
    instances: ClassVar[list["FakeClient"]] = []

    def __init__(self, **kw):
        self.init_kw = kw
        self.session: dict[str, Any] = {}
        self.message: dict[str, Any] = {}
        self.cwd_existed_during = False
        self.closed = False
        FakeClient.instances.append(self)

    async def connect(self):
        pass

    async def initialize_session(self, **kw):
        self.session = kw
        self.cwd_existed_during = os.path.isdir(kw["cwd"])

    async def add_user_message(self, **kw):
        self.message = kw

    async def receive_response(self):
        if FakeClient.hang:
            await asyncio.sleep(30)
        for ev in FakeClient.script:
            yield ev

    async def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def fake_droid(monkeypatch):
    FakeClient.script = [Delta(ANSWER), Done(Usage(100, 20))]
    FakeClient.hang = False
    FakeClient.instances = []
    monkeypatch.setattr(factory.shutil, "which", lambda name: "/usr/bin/droid")
    monkeypatch.setattr(settings, "factory_api_key", "fk-test")
    monkeypatch.setattr(settings, "factory_model", "")
    monkeypatch.setattr(settings, "factory_timeout_seconds", 5.0)
    sdk = SimpleNamespace(
        DroidClient=FakeClient, AutonomyLevel=Level, ReasoningEffort=Effort,
        AssistantTextDelta=Delta, ErrorEvent=Err, TurnComplete=Done,
    )
    monkeypatch.setattr(factory, "_load_sdk", lambda: sdk)


def msgs(text="decide"):
    return [{"role": "user", "content": text}]


def test_none_when_droid_is_not_on_path(monkeypatch):
    monkeypatch.setattr(factory.shutil, "which", lambda name: None)
    assert factory.factory_ask() is None


def test_none_without_a_key(monkeypatch):
    monkeypatch.setattr(settings, "factory_api_key", None)
    assert factory.factory_ask() is None


def test_none_when_the_sdk_cannot_be_imported(monkeypatch):
    monkeypatch.setattr(factory, "_load_sdk", lambda: None)
    assert factory.factory_ask() is None


def test_answer_and_provider():
    r = factory.factory_ask()(msgs())
    assert r.text == ANSWER
    assert r.provider == "factory"
    assert r.content == [{"type": "text", "text": ANSWER}]


def test_session_is_locked_down_and_the_temp_cwd_is_removed(monkeypatch):
    monkeypatch.setattr(settings, "factory_model", "some-model")
    schema = {"type": "object"}
    factory.factory_ask(schema=schema)(msgs("hello"))
    (c,) = FakeClient.instances
    assert c.init_kw["exec_path"] == "droid"
    assert c.init_kw["env"] == {"FACTORY_API_KEY": "fk-test"}
    s = c.session
    assert s == {
        "machine_id": "access-desk",
        "cwd": c.init_kw["cwd"],
        "model_id": "some-model",
        "autonomy_level": Level.Off,
        "reasoning_effort": Effort.Low,
        "restrict_tool_ids": [],
        "disable_builtin_skills": True,
        "auto_reject_permission_requests": True,
    }
    assert "skip_permissions_unsafe" not in s
    assert c.message == {"text": "hello",
                         "output_format": {"type": "json_schema", "schema": schema}}
    assert c.cwd_existed_during
    assert not os.path.exists(s["cwd"])
    assert c.closed


def test_empty_model_means_droids_default():
    factory.factory_ask()(msgs())
    assert FakeClient.instances[0].session["model_id"] is None


def test_default_schema_is_the_decision_schema():
    factory.factory_ask()(msgs())
    schema = FakeClient.instances[0].message["output_format"]["schema"]
    assert "to_tier" in schema["properties"]


def test_token_usage_is_captured():
    usage: list = []
    factory.factory_ask(usage=usage)(msgs())
    assert usage == [Usage(100, 20)]


def test_fenced_json_is_unwrapped():
    FakeClient.script = [Delta("```json\n"), Delta(ANSWER), Delta("\n```"), Done()]
    assert factory.factory_ask()(msgs()).text == ANSWER


@pytest.mark.parametrize("script", [
    [Done()],  # empty answer
    [Delta("   "), Done()],
    [Delta("I can't help with that."), Done()],  # a refusal in prose, not JSON
    [Delta("{not json"), Done()],
    [Err("rate limited"), Done()],
])
def test_unusable_answers_raise(script):
    FakeClient.script = script
    with pytest.raises(DecisionUnavailable):
        factory.factory_ask()(msgs())
    assert not os.path.exists(FakeClient.instances[0].init_kw["cwd"])


def test_timeout_raises_and_cleans_up():
    FakeClient.hang = True
    with pytest.raises(DecisionUnavailable, match="timed out"):
        factory.factory_ask(timeout=0.05)(msgs())
    # One try per attempt (settings.factory_attempts), each closed and its folder removed.
    assert len(FakeClient.instances) == settings.factory_attempts == 2
    for c in FakeClient.instances:
        assert c.closed
        assert not os.path.exists(c.init_kw["cwd"])


def test_a_cut_short_session_is_retried_in_a_fresh_one(monkeypatch):
    """Under load Droid sometimes ends a session early; the second session's answer is used."""
    first = FakeClient.script
    seen = {"n": 0}
    orig = FakeClient.receive_response

    async def flaky(self):
        seen["n"] += 1
        if seen["n"] == 1:  # first session: text cut off mid-JSON
            yield Delta("{\"action\": \"sta")
            yield Done(None)
            return
        async for ev in orig(self):
            yield ev

    monkeypatch.setattr(FakeClient, "receive_response", flaky)
    out = factory.factory_ask()(msgs())
    assert json.loads(out.text) and out.provider == "factory"
    assert len(FakeClient.instances) == 2 and first is FakeClient.script


def test_attempts_setting_limits_retries(monkeypatch):
    monkeypatch.setattr(settings, "factory_attempts", 1)
    FakeClient.hang = True
    with pytest.raises(DecisionUnavailable):
        factory.factory_ask(timeout=0.05)(msgs())
    assert len(FakeClient.instances) == 1


def test_retry_prompt_carries_the_original_and_the_violations():
    ask = factory.factory_ask()
    ask([
        {"role": "user", "content": "ORIGINAL REQUEST"},
        {"role": "assistant", "content": [{"type": "text", "text": "{bad}"}]},
        {"role": "user", "content": "That decision was rejected:\n- max_down: too far"},
    ])
    sent = FakeClient.instances[0].message["text"]
    assert sent.startswith("ORIGINAL REQUEST")
    assert "- max_down: too far" in sent
    assert "{bad}" not in sent  # no session state: the old answer isn't replayed


def test_flatten_accepts_sdk_blocks_and_strings():
    block = SimpleNamespace(type="text", text="from a block")
    assert factory.flatten([{"role": "user", "content": [block]}]) == "from a block"


def test_works_from_inside_a_running_event_loop():
    async def main():
        return factory.factory_ask()(msgs()).text

    assert asyncio.run(main()) == ANSWER
