from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the repo-root .env, then the process environment."""

    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    stdb_http_url: str = "https://maincloud.spacetimedb.com"
    stdb_database: str = "access-desk-calhacks13"
    stdb_agent_token: str | None = None
    stdb_demo_token: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"
    factory_api_key: str | None = None
    # Factory (Droid) decides; Claude answers if Factory is unavailable or fails; then the rules.
    # Passed the provider gate on claude-opus-5-5 (docs/llm.md). LLM_PROVIDER=anthropic rolls back.
    llm_provider: Literal["anthropic", "factory"] = "factory"
    llm_fallback: str = "anthropic"  # comma list tried after llm_provider
    factory_model: str = "claude-opus-5-5"  # the model the gate was run on; empty = Droid's default
    factory_timeout_seconds: float = 120.0
    # Droid sessions that time out or come back cut short are retried this many times in all.
    factory_attempts: int = 2
    agent_interval_seconds: float = 15.0
    watch_seconds: float = 1.0
    # Seat 2's LLM calls, in order (see seat2_llm.py). The classifier gates the "already paid" moment.
    seat2_rm_note_providers: str = "anthropic,factory"
    seat2_notice_providers: str = "factory,anthropic"
    seat2_factory_timeout_seconds: float = 15.0
    stdb_parallel_requests: int = 4
    escalation_days: int = 7
    unwind_cost_bps: int = 50


settings = Settings()
