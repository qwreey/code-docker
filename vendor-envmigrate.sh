#!/bin/sh
set -e

# router/backend's Docker build context is router/ only (see
# router/CLAUDE.md), so it can't COPY the repo-root envmigrate/ module
# directly the way webmanager's own Dockerfile stage does. `go mod vendor`
# materializes a real copy into router/backend/vendor/ instead, which lives
# inside router's own build context and gets COPY'd like any other source
# file (see router/Dockerfile's router-manager-build stage).
#
# Run this after editing anything under envmigrate/, before `docker compose
# build` (or `docker compose build code-docker-router`) - `go build` itself
# checks vendor/modules.txt against go.mod and fails loudly on mismatch, so
# forgetting this step is a build error, not a silent staleness bug.
cd "$(dirname "$0")/router/backend"
go mod vendor
echo "vendor-envmigrate: router/backend/vendor/code-docker/envmigrate refreshed"
