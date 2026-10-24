from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the repo-root .env, then the process environment."""

    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    stdb_http_url: str = "https://maincloud.spacetimedb.com"
    stdb_database: str = "access-desk-calhacks13"
    stdb_agent_token: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"
    factory_api_key: str | None = None
    agent_interval_seconds: float = 15.0
    watch_seconds: float = 1.0
    escalation_days: int = 7
    unwind_cost_bps: int = 50


settings = Settings()
