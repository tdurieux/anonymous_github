#!/usr/bin/env bash
# Zero-downtime redeploy:
#   build → blue/green streamer swap → recreate API.
# Skips everything if the rebuilt image hasn't changed (FORCE=1 to override).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

IMAGE="${IMAGE:-tdurieux/anonymous_github:v2}"
REPLICAS="${STREAMER_REPLICAS:-4}"
TIMEOUT="${HEALTH_TIMEOUT:-90}"
FORCE="${FORCE:-0}"

log()  { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }

image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

wait_healthy() {
    local name="$1" waited=0 status
    while (( waited < TIMEOUT )); do
        status="$(docker inspect -f \
            '{{if .State.Health}}{{.State.Health.Status}}{{else if .State.Running}}running{{else}}stopped{{end}}' \
            "$name" 2>/dev/null || echo missing)"
        [[ $status == healthy || $status == running ]] && return 0
        sleep 2; waited=$((waited + 2))
    done
    warn "$name not healthy after ${TIMEOUT}s (status=$status)"
    return 1
}

list_streamers() {
    docker compose ps --status running --format '{{.Name}}' streamer 2>/dev/null
}

# 1. Build
log "Building image"
before="$(image_id "$IMAGE")"
docker compose build anonymous_github
after="$(image_id "$IMAGE")"

# 2. Cold start
mapfile -t olds < <(list_streamers)
if [[ ${#olds[@]} -eq 0 ]]; then
    log "Cold start — bringing the whole stack up"
    docker compose up -d --remove-orphans
    docker compose ps
    exit 0
fi

# 3. No-op if image unchanged
if [[ -n $before && $before == "$after" && $FORCE != 1 ]]; then
    log "Image unchanged — nothing to deploy (FORCE=1 to override)"
    docker compose ps
    exit 0
fi

# 4. Blue/green streamer swap
log "Swapping streamer (${#olds[@]} old → ${REPLICAS} new)"
docker compose up -d --no-deps --no-recreate \
    --scale "streamer=$((${#olds[@]} + REPLICAS))" streamer >/dev/null

# Anything not in $olds is new.
declare -A was_old=()
for o in "${olds[@]}"; do was_old[$o]=1; done
news=()
while IFS= read -r n; do
    [[ -n $n && -z ${was_old[$n]:-} ]] && news+=("$n")
done < <(list_streamers)

# Wait for all new replicas to be healthy in parallel.
pids=()
for n in "${news[@]}"; do wait_healthy "$n" & pids+=($!); done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=1; done
if [[ $fail == 1 ]]; then
    warn "new replicas unhealthy — keeping olds in place"
    exit 1
fi

# Drop olds and reconcile scale.
docker rm -f "${olds[@]}" >/dev/null
docker compose up -d --no-deps --no-recreate --scale "streamer=${REPLICAS}" streamer >/dev/null

# 5. Recreate API. --no-deps: we already manage every dependency above,
#    skipping compose's own depends_on health re-poll (~5–10s).
log "Recreating API"
docker compose up -d --no-deps --remove-orphans anonymous_github
api="$(docker compose ps -q anonymous_github | head -1)"
[[ -n $api ]] && wait_healthy "$api" || true

docker compose ps
