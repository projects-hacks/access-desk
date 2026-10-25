# The four agents (Learning, Scoring, ExploitWatch, Access), woken by tasks the database queues. One instance only.
# Built from the repo root: docker build -f agents/Dockerfile .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Factory's Droid CLI: @factory/droid-sdk runs it for each decision.
RUN curl -fsSL https://app.factory.ai/cli | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY spacetime/package.json spacetime/
COPY agents/package.json agents/
RUN pnpm install --frozen-lockfile --filter @access-desk/agents

COPY agents/ agents/

ENV AGENTS_HOST=true
CMD ["pnpm", "--filter", "@access-desk/agents", "start"]
