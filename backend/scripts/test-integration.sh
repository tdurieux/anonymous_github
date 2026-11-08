#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
go_binary=${GO_BINARY:-go}
project="anonymous-go-test-$$"
artifacts=$(mktemp -d)
cleanup() {
  docker compose -p "$project" -f compose.test.yml down --volumes >/dev/null 2>&1 || true
  rm -rf "$artifacts"
}
trap cleanup EXIT
"$go_binary" build -o "$artifacts/server" ./cmd/server
docker compose -p "$project" -f compose.test.yml up -d
mongo_address=$(docker compose -p "$project" -f compose.test.yml port mongo 27017)
redis_address=$(docker compose -p "$project" -f compose.test.yml port redis 6379)
for attempt in {1..30}; do
  if docker compose -p "$project" -f compose.test.yml exec -T mongo mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then break; fi
  sleep 1
done
GO_TEST_MONGODB_URI="mongodb://$mongo_address" GO_TEST_REDIS_ADDR="$redis_address" GO_TEST_SERVER_BINARY="$artifacts/server" "$go_binary" test -race -count=1 ./... "$@"
