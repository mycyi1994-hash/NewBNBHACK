# Worker image for apps/agent (SPEC §13): Node 22 + pnpm workspace, run with tsx.
# Secrets are Fly secrets (runtime env), never files: .dockerignore drops every .env*.
FROM node:22-bookworm-slim

ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY packages/binance/package.json packages/binance/
COPY packages/chain/package.json packages/chain/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY scripts/package.json scripts/
# The worker, the scripts (pnpm reach, db:count on the host) and the root toolchain (tsx).
RUN pnpm install --frozen-lockfile --filter ijaro --filter "@ijaro/agent..." --filter "@ijaro/scripts..."

COPY . .
# Fail the build if any env file slipped into the context.
RUN if find / -xdev -name '.env*' -not -name '.env.example' -print -quit 2>/dev/null | grep -q .; then \
      echo 'refusing to build: .env file in image' >&2; exit 1; fi

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@ijaro/agent", "start"]
