#!/usr/bin/env bash
set -euo pipefail

# FriesGo Global Worker Deploy Helper
# Always injects the exact 40-char Git HEAD SHA into BUILD_COMMIT so /api/health
# is strictly verifiable against the published repository commit.

TARGET="${1:-staging}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/workers/friesgo-api"
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"

if [[ "$TARGET" == "staging" ]]; then
  echo "Deploying friesgo-api-staging with BUILD_COMMIT=$GIT_SHA ..."
  (cd "$WORKER_DIR" && npx wrangler deploy --env staging --var "BUILD_COMMIT:$GIT_SHA")
elif [[ "$TARGET" == "production" ]]; then
  echo "Deploying friesgo-api (production) with BUILD_COMMIT=$GIT_SHA ..."
  (cd "$WORKER_DIR" && npx wrangler deploy --var "BUILD_COMMIT:$GIT_SHA")
else
  echo "Usage: $0 [staging|production]" >&2
  exit 1
fi
