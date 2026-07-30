#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
primary_files=(
  -f "$repository_root/docker-compose.yml"
  -f "$repository_root/docker-compose.replica-primary.yml"
)
secondary_files=(
  -f "$repository_root/docker-compose.replica-secondary.yml"
)

compose_prefix=(docker compose)
if [[ -n "${COMPOSE_ENV_FILE:-}" ]]; then
  compose_prefix+=(--env-file "$COMPOSE_ENV_FILE")
fi

keyfile="${MONGO_REPLICA_KEYFILE:-$repository_root/secrets/mongo-replica-keyfile}"
if [[ "$keyfile" != /* ]]; then
  keyfile="$repository_root/${keyfile#./}"
fi

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/mongodb-replica.sh generate-key
  ./scripts/mongodb-replica.sh primary-up <primary-hostname:port>
  ./scripts/mongodb-replica.sh secondary-up <secondary-hostname:port>
  ./scripts/mongodb-replica.sh add-secondary <secondary-hostname:port> [delay-seconds]
  ./scripts/mongodb-replica.sh status

Environment:
  COMPOSE_ENV_FILE         Optional Compose environment file.
  MONGO_REPLICA_KEYFILE    Shared keyfile path (default: ./secrets/mongo-replica-keyfile).

The primary and secondary hostnames must resolve from both MongoDB servers.
The remote member is added hidden, priority 0, and non-voting so a WAN outage
cannot block production majority writes. Set delay-seconds to 0 for no delay.
USAGE
}

validate_host() {
  if [[ ! "$1" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]]; then
    echo "Expected a resolvable hostname and port, for example mongo-primary.internal:27017" >&2
    exit 2
  fi
}

validate_delay() {
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    echo "Delay must be a non-negative number of seconds" >&2
    exit 2
  fi
}

require_keyfile() {
  if [[ ! -s "$keyfile" ]]; then
    echo "Replica keyfile not found: $keyfile" >&2
    echo "Run ./scripts/mongodb-replica.sh generate-key first." >&2
    exit 2
  fi
}

primary_compose() {
  "${compose_prefix[@]}" "${primary_files[@]}" "$@"
}

secondary_compose() {
  "${compose_prefix[@]}" "${secondary_files[@]}" "$@"
}

mongo_eval() {
  local javascript="$1"
  primary_compose exec -T -e "MONGO_RS_EVAL=$javascript" mongodb sh -eu -c \
    'mongosh --quiet \
      --username="$MONGO_INITDB_ROOT_USERNAME" \
      --password="$MONGO_INITDB_ROOT_PASSWORD" \
      --authenticationDatabase=admin \
      --eval "$MONGO_RS_EVAL"'
}

wait_for_primary_container() {
  local attempt
  for attempt in $(seq 1 60); do
    if primary_compose exec -T mongodb sh -eu -c \
      'mongosh --quiet \
        --username="$MONGO_INITDB_ROOT_USERNAME" \
        --password="$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase=admin \
        --eval "db.adminCommand({ ping: 1 }).ok"' >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  echo "MongoDB did not become ready within 120 seconds" >&2
  exit 1
}

wait_for_replica_primary() {
  local attempt
  for attempt in $(seq 1 60); do
    if mongo_eval \
      "if (!db.hello().isWritablePrimary) throw new Error('not primary yet');" \
      >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  echo "Replica set rs0 did not elect a writable primary within 120 seconds" >&2
  echo "Check ./scripts/mongodb-replica.sh status and the MongoDB container logs." >&2
  exit 1
}

wait_for_secondary_container() {
  local attempt
  for attempt in $(seq 1 60); do
    if secondary_compose exec -T mongodb-secondary mongosh --quiet \
      --eval "db.adminCommand({ ping: 1 }).ok" >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  echo "Secondary MongoDB did not become ready within 120 seconds" >&2
  exit 1
}

check_primary_endpoint() {
  local endpoint="$1"
  primary_compose exec -T -e "MONGO_RS_ENDPOINT=$endpoint" mongodb sh -eu -c '
    host="${MONGO_RS_ENDPOINT%:*}"
    port="${MONGO_RS_ENDPOINT##*:}"
    echo "Checking $host resolves inside the primary MongoDB container:"
    getent hosts "$host"
    mongosh --quiet --host "$host" --port "$port" \
      --eval "db.adminCommand({ ping: 1 }).ok" >/dev/null
  ' || {
    echo "The endpoint $endpoint does not resolve to a reachable MongoDB instance from the primary container." >&2
    echo "Check MONGO_PRIMARY_HOSTNAME, MONGO_PRIMARY_ADDRESS, MONGO_SECONDARY_HOSTNAME, and MONGO_SECONDARY_ADDRESS." >&2
    exit 1
  }
}

check_secondary_endpoint() {
  local endpoint="$1"
  secondary_compose exec -T -e "MONGO_RS_ENDPOINT=$endpoint" mongodb-secondary sh -eu -c '
    host="${MONGO_RS_ENDPOINT%:*}"
    port="${MONGO_RS_ENDPOINT##*:}"
    echo "Checking $host resolves inside the secondary MongoDB container:"
    getent hosts "$host"
    mongosh --quiet --host "$host" --port "$port" \
      --eval "db.adminCommand({ ping: 1 }).ok" >/dev/null
  ' || {
    echo "The endpoint $endpoint does not resolve to the secondary MongoDB container." >&2
    echo "Check MONGO_SECONDARY_HOSTNAME and the secondary Compose configuration." >&2
    exit 1
  }
}

command="${1:-}"
case "$command" in
  generate-key)
    if [[ -e "$keyfile" ]]; then
      echo "Refusing to overwrite existing keyfile: $keyfile" >&2
      exit 2
    fi
    mkdir -p "$(dirname "$keyfile")"
    umask 077
    openssl rand -base64 756 > "$keyfile"
    chmod 600 "$keyfile"
    echo "Created $keyfile"
    echo "Copy this exact file securely to the secondary server."
    ;;

  primary-up)
    primary_host="${2:-}"
    validate_host "$primary_host"
    require_keyfile
    primary_compose up -d mongodb
    wait_for_primary_container
    check_primary_endpoint "$primary_host"
    mongo_eval "
      try {
        const status = rs.status();
        print('Replica set already initialized as ' + status.set);
      } catch (error) {
        if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error;
        printjson(rs.initiate({
          _id: 'rs0',
          members: [{ _id: 0, host: '$primary_host', priority: 1, votes: 1 }]
        }));
      }
    "
    wait_for_replica_primary
    ;;

  secondary-up)
    secondary_host="${2:-}"
    validate_host "$secondary_host"
    require_keyfile
    secondary_compose up -d mongodb-secondary
    wait_for_secondary_container
    check_secondary_endpoint "$secondary_host"
    ;;

  add-secondary)
    secondary_host="${2:-}"
    delay="${3:-3600}"
    validate_host "$secondary_host"
    validate_delay "$delay"
    check_primary_endpoint "$secondary_host"
    mongo_eval "
      const host = '$secondary_host';
      const existing = rs.conf().members.find((member) => member.host === host);
      if (existing) {
        print('Secondary already configured: ' + host);
      } else {
        printjson(rs.add({
          host,
          priority: 0,
          votes: 0,
          hidden: true,
          secondaryDelaySecs: $delay
        }));
      }
    "
    ;;

  status)
    mongo_eval "
      printjson(rs.status().members.map((member) => ({
        name: member.name,
        state: member.stateStr,
        health: member.health,
        replicationTime: member.optimeDate
      })));
    "
    ;;

  *)
    usage
    [[ -n "$command" ]] && exit 2
    ;;
esac
