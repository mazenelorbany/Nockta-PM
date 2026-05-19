#!/usr/bin/env bash
# =============================================================================
# Nockta Flow — one-command local dev.
#
# 1. Boot the essential infra services (Postgres, Redis, MinIO) via docker.
# 2. Wait until Postgres + Redis are healthy.
# 3. Sync the Prisma schema (idempotent — safe to run repeatedly).
# 4. Hand off to turbo, which runs api / web / client / workers in parallel.
#
# Ctrl+C stops the apps. Docker containers keep running (faster restarts).
# Use `pnpm docker:down` to stop them.
# =============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# --- pre-flight ---

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker not found on PATH. Install Docker Desktop and try again."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker isn't running. Start Docker Desktop and try again."
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ pnpm not found. Run: corepack enable && corepack prepare pnpm@9.12.0 --activate"
  exit 1
fi

# Make sure dependencies are installed. node_modules at the workspace root is
# enough of a signal — pnpm hoists workspace deps there.
if [ ! -d "$ROOT/node_modules" ] || [ ! -d "$ROOT/apps/api/node_modules" ]; then
  echo "→ node_modules missing — running pnpm install..."
  pnpm install
fi

COMPOSE_FILE="$ROOT/infra/docker-compose.yml"

# --- pre-flight: nuke stray dev processes from a previous run ---
# A crashed (or still-running) prior `pnpm dev` leaves Vite, Nest, tsx-watch,
# and turbo processes alive — they hold ports AND confuse a fresh pnpm
# invocation (manifests as `ECANCELED: operation canceled, read`).
echo "→ Killing stray dev processes from prior runs..."

# 1. Kill anything holding our dev ports (API, web, Prisma Studio).
for port in 3000 5173 5555; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "   port $port → pid(s) $pids"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

# 2. Kill any orphan dev-tool processes by name. pkill -f matches against the
#    full command line, which catches `tsx watch src/main.ts` etc. Tolerate
#    no-match (exit code 1) — that just means nothing was running.
for pattern in \
    "turbo run dev" \
    "nest start" \
    "tsx watch" \
    "vite" \
    "ts-node-dev"; do
  pkill -9 -f "$pattern" 2>/dev/null || true
done

# 3. Brief settle to let the kernel reclaim sockets before docker --wait /
#    turbo dev bind them again.
sleep 1

echo "→ Starting Postgres + Redis + MinIO (waiting for healthy)..."
# Long-running services first — `--wait` blocks until each reports healthy.
docker compose -f "$COMPOSE_FILE" up -d --wait postgres redis minio

# minio-init is a one-shot bucket-bootstrap container that exits 0 when done.
# `--wait` treats one-shot exits as failures, so run it separately and tolerate
# a non-zero exit (it re-runs on every `pnpm dev` and the buckets already exist
# after the first run, which mc treats as a hard error in some images).
echo "→ Ensuring MinIO buckets exist..."
docker compose -f "$COMPOSE_FILE" up -d minio-init || true

# --- optional heavier services ---
# These are slow to boot and only needed by specific features. Set
# NOCKTA_FULL_STACK=1 to start them alongside the essentials.

if [ "${NOCKTA_FULL_STACK:-0}" = "1" ]; then
  echo "→ Starting full stack (ClamAV, Qdrant, Ollama, Mailhog, Prometheus, Loki, Grafana)..."
  docker compose -f "$COMPOSE_FILE" up -d clamav qdrant ollama mailhog prometheus loki grafana
fi

# --- prisma sync ---
# Invoke the prisma binary directly (apps/api/node_modules/.bin/prisma) instead
# of via `pnpm --filter`. This avoids any pnpm-inside-pnpm chain when the
# script is launched as `pnpm dev` — pnpm 9 throws ECANCELED on nested calls.
# Prisma reads .env + finds schema relative to its cwd, so we cd in.

PRISMA_BIN="$ROOT/apps/api/node_modules/.bin/prisma"
if [ ! -x "$PRISMA_BIN" ]; then
  echo "❌ Prisma not found at $PRISMA_BIN. Re-run pnpm install."
  exit 1
fi

echo "→ Generating Prisma client..."
(cd "$ROOT/apps/api" && "$PRISMA_BIN" generate) >/dev/null

echo "→ Pushing schema to dev database..."
# Prisma 7 dropped --skip-generate from `db push`. Client generation already
# happened in the step above (line 108), so plain `db push` is equivalent.
(cd "$ROOT/apps/api" && "$PRISMA_BIN" db push)

# Apply companion SQL — partial unique indexes, check constraints, FTS columns.
# Idempotent (every statement uses IF NOT EXISTS / DROP IF EXISTS). Runs via
# the postgres container so we don't need psql installed on the host.
# Errors here are not fatal: db push has already produced a usable schema, and
# the companion is for correctness invariants the app also enforces.
echo "→ Applying companion SQL (constraints, FTS columns)..."
if ! docker exec -i nockta-postgres psql -U nockta -d nockta_flow -v ON_ERROR_STOP=1 \
      < apps/api/prisma/migrations/companion.sql > /dev/null 2>&1; then
  echo "   ⚠  companion.sql had warnings — continuing anyway (see apps/api/prisma/migrations/companion.sql)."
fi

# --- run apps ---

echo ""
echo "✅ Infra ready."
echo "   API     → http://localhost:3000   (Swagger: /docs)"
echo "   Web     → http://localhost:5173"
echo "   MinIO   → http://localhost:9001   (user nockta_minio / pw nockta_minio_dev_pw)"
echo ""
echo "→ Starting apps via turbo. Ctrl+C to stop."
echo ""

# Invoke turbo directly via the workspace-root binary, NOT through `pnpm`.
# Nesting pnpm inside pnpm (parent: `pnpm dev` → `bash scripts/dev.sh` → child:
# `pnpm turbo run dev`) makes pnpm 9 throw ECANCELED on stdin handling. Using
# the local turbo binary sidesteps that entirely.
TURBO_BIN="$ROOT/node_modules/.bin/turbo"
if [ ! -x "$TURBO_BIN" ]; then
  echo "❌ Could not find turbo at $TURBO_BIN. Run pnpm install and try again."
  exit 1
fi
exec "$TURBO_BIN" run dev
