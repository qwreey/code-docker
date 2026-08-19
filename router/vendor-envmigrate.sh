#!/bin/sh
set -e

# router's own Docker build context is router/ only, so it can't COPY a
# sibling envmigrate/ checkout from outside this repo - it carries its own
# envmigrate submodule (router/envmigrate) instead. `go mod vendor`
# materializes a real copy into backend/vendor/, which lives inside this
# repo's own build context and gets COPY'd like any other source file (see
# Dockerfile's router-manager-build stage).
#
# Run this after updating the envmigrate submodule, before `docker build`
# (or `docker compose build code-docker-router` from code-docker) - `go
# build` itself checks vendor/modules.txt against go.mod and fails loudly on
# mismatch, so forgetting this step is a build error, not a silent
# staleness bug.
cd "$(dirname "$0")/backend"
go mod vendor
echo "vendor-envmigrate: backend/vendor/github.com/qwreey/envmigrate refreshed"
