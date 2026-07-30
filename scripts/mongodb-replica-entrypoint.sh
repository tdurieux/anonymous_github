#!/usr/bin/env bash
set -Eeuo pipefail

source_keyfile="${MONGO_REPLICA_KEYFILE_PATH:-/run/secrets/mongo-replica-keyfile}"
runtime_keyfile="/tmp/mongo-replica-keyfile"

if [[ ! -s "$source_keyfile" ]]; then
  echo "MongoDB replica keyfile is missing or empty: $source_keyfile" >&2
  exit 1
fi

# Bind-mounted secrets commonly have host ownership or permissive modes that
# mongod rejects. Copy to an ephemeral location with the required ownership
# and permissions before the official image entrypoint drops privileges.
install -m 400 -o mongodb -g mongodb "$source_keyfile" "$runtime_keyfile"

exec /usr/local/bin/docker-entrypoint.sh "$@"
