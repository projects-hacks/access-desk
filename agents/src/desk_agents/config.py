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
    llm_provider: Literal["anthropic", "factory"] = "anthropic"
    llm_fallback: str = ""  # comma list tried after llm_provider, e.g. "anthropic"
    factory_model: str = ""  # empty = Droid's default
    factory_timeout_seconds: float = 60.0
    agent_interval_seconds: float = 15.0
    watch_seconds: float = 1.0
    stdb_parallel_requests: int = 4
    escalation_days: int = 7
    unwind_cost_bps: int = 50


settings = Settings()
