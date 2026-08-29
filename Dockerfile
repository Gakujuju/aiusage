FROM node:20-slim

LABEL org.opencontainers.image.title="aiusage" \
      org.opencontainers.image.description="Track AI coding assistant usage, token consumption, cost, and tool calls across Claude Code, Codex, OpenCode, and more" \
      org.opencontainers.image.url="https://github.com/juliantanx/aiusage" \
      org.opencontainers.image.source="https://github.com/juliantanx/aiusage" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

COPY . .
# Only build server packages (skip Electron widget)
RUN pnpm --filter @aiusage/core build && pnpm --filter @aiusage/web build && pnpm --filter @juliantanx/aiusage build

VOLUME /root/.aiusage
EXPOSE 3847

# --host 0.0.0.0 is required here: serve binds 127.0.0.1 by default, which in a
# container means nothing outside it can connect. Because this bind is reachable
# from the network, serve will refuse to start without AIUSAGE_DASHBOARD_PASSWORD
# — set it, or set AIUSAGE_ALLOW_INSECURE_HOST=1 if something else already
# protects this port. That refusal is deliberate: the dashboard serves total
# spend, project names and subscription usage.
CMD ["node", "packages/cli/dist/index.js", "serve", "--port", "3847", "--host", "0.0.0.0"]
