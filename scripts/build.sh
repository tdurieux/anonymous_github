#!/usr/bin/env bash
# Fast local image build with BuildKit enabled.
set -euo pipefail
cd "$(dirname "$0")/.."

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

docker compose build "$@" anonymous_github
