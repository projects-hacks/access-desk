from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the repo-root .env, then the process environment."""

    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    stdb_http_url: str = "http://localhost:3000"
    stdb_database: str = "access-desk"
    stdb_agent_token: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"
    factory_api_key: str | None = None
    agent_interval_seconds: float = 15.0


settings = Settings()
