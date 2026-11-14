#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
go_binary=${GO_BINARY:-go}
project="anonymous-http-benchmark-$$"
artifacts=$(mktemp -d)
cleanup() {
  docker compose -p "$project" -f backend/compose.test.yml down --volumes >/dev/null 2>&1 || true
  rm -rf "$artifacts"
}
trap cleanup EXIT
server_binary=${BENCH_EXISTING_BINARY:-"$artifacts/server"}
if [[ -z "${BENCH_EXISTING_BINARY:-}" ]]; then
  "$go_binary" build -C backend -o "$server_binary" ./cmd/server
fi
docker compose -p "$project" -f backend/compose.test.yml up -d
mongo_address=$(docker compose -p "$project" -f backend/compose.test.yml port mongo 27017)
redis_address=$(docker compose -p "$project" -f backend/compose.test.yml port redis 6379)
for attempt in {1..30}; do
  if docker compose -p "$project" -f backend/compose.test.yml exec -T mongo mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then break; fi
  sleep 1
done
BENCH_MONGODB_URI="mongodb://$mongo_address" BENCH_REDIS_ADDR="$redis_address" BENCH_GO_SERVER="$server_binary" BENCH_GO_VERSION="$("$go_binary" version)" node "${BENCH_SCRIPT:-backend/scripts/benchmark-http.cjs}" "$@"
