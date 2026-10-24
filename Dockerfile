# The API server: sync, gateway, simulated platform, demo controls. One instance only.
FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY spacetime/package.json spacetime/
RUN pnpm install --frozen-lockfile --filter @access-desk/server

COPY server/ server/
COPY .data/nessie-dev.json .data/

ENV SERVER_HOST=true DEMO_CONTROLS=true PORT=4000
EXPOSE 4000
CMD ["pnpm", "--filter", "@access-desk/server", "start"]
