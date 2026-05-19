#!/bin/sh
# =============================================================================
# Production startup for @nockta/api.
#
#   1. Run Prisma migrations (idempotent — Prisma tracks applied ones).
#   2. Apply companion.sql — partitioning, FTS columns, partial unique indexes,
#      check constraints, materialized views. Idempotent; safe on every boot.
#   3. Start the NestJS process.
#
# psql is bundled into the runtime image (postgresql-client apk package). It
# parses DO $$ ... $$ blocks correctly — Prisma's executeRawUnsafe does not,
# which is why we don't try to do this from inside Node.
#
# Boot fails fast on any non-zero exit so Railway restarts cleanly.
# =============================================================================
set -eu

echo "[start] step 1/3 — prisma migrate deploy"
# Use the prisma CLI bin symlink that pnpm publishes into the workspace
# package's node_modules. Going through the deep .pnpm path is brittle
# across prisma versions.
./node_modules/.bin/prisma migrate deploy

echo "[start] step 2/3 — companion.sql (partitioning, FTS, MVs, constraints)"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[start] ERROR: DATABASE_URL is not set; companion.sql cannot be applied"
  exit 1
fi
# Strip Prisma-only query parameters that libpq rejects. Prisma routinely
# appends `?schema=public` (and friends like `?connection_limit=`,
# `?pgbouncer=`) to DATABASE_URL; psql only knows the canonical libpq
# parameters and bails on anything else. Cutting the entire query string
# is safe — companion.sql operates on the default `public` schema
# explicitly, and we don't rely on any libpq-only params here.
PSQL_URL="${DATABASE_URL%%\?*}"
# --single-transaction wraps every statement in a transaction so any failure
# rolls the whole companion script back. Combined with ON_ERROR_STOP=1 this
# means a malformed statement halts boot immediately rather than silently
# leaving the DB half-migrated.
psql "$PSQL_URL" \
  --single-transaction \
  --set ON_ERROR_STOP=1 \
  --file prisma/migrations/companion.sql \
  > /tmp/companion.log 2>&1 \
  && echo "[start] companion.sql applied OK" \
  || { echo "[start] companion.sql FAILED — log:"; cat /tmp/companion.log; exit 1; }

echo "[start] step 3/3 — starting NestJS on :${PORT:-3000}"
exec node dist/main.js
