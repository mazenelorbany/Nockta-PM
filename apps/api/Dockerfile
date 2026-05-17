# =============================================================================
# Multi-stage build for @nockta/api — runs the NestJS API and its in-process
# BullMQ workers. Build context expected at the repo root.
#
#   docker build -f apps/api/Dockerfile -t nockta-api .
# =============================================================================

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
# Sharp needs vips at runtime, ClamAV stream client uses native net so nothing extra needed.
RUN apk add --no-cache libc6-compat openssl

# --- deps stage: install workspace dependencies ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/ui/package.json ./packages/ui/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
RUN pnpm install --frozen-lockfile --filter @nockta/api...

# --- build stage ---
FROM base AS build
COPY --from=deps /app /app
COPY tsconfig.base.json turbo.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm --filter @nockta/api exec prisma generate
RUN pnpm --filter @nockta/api build

# --- runtime stage ---
FROM node:20-alpine AS runtime
# Runtime deps:
#   - ffmpeg + poppler-utils: AttachmentThumbnailProcessor uses these for
#     video and PDF first-page thumbnails (spec §12).
#   - postgresql-client: the startup script applies companion.sql via psql
#     (partitioning, FTS, materialized views — things Prisma can't express).
#   - tini: PID-1 signal forwarding for graceful shutdown.
RUN apk add --no-cache libc6-compat openssl tini ffmpeg poppler-utils postgresql-client
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
ENV NODE_ENV=production PORT=3000

COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/scripts ./scripts
COPY --from=build /app/apps/api/package.json ./package.json
# node_modules from the workspace root — Prisma client lives here.
COPY --from=build /app/node_modules ./node_modules

RUN chmod +x ./scripts/start.sh

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# Migrations + companion.sql run from scripts/start.sh so the boot sequence
# is auditable in logs and any DDL failure halts boot loudly.
CMD ["./scripts/start.sh"]
