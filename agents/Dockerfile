# The agents (credit analyst, ExploitWatch, access controller), one always-on loop.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Factory's Droid CLI: the droid-sdk runs `droid exec` for each decision.
RUN curl -fsSL https://app.factory.ai/cli | sh
ENV PATH="/root/.local/bin:${PATH}"
COPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /uvx /bin/

WORKDIR /app/agents
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src/ src/
RUN uv sync --frozen --no-dev

ENV PYTHONUNBUFFERED=1 AGENTS_HOST=true
CMD ["uv", "run", "--no-sync", "desk-agents"]
