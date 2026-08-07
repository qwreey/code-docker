#!/bin/sh
set -e

# netinit/ and code-dind/ each have their own isolated Dockerfile build
# context (see netinit/CLAUDE.md, code-dind/CLAUDE.md) - they can't COPY
# the repo-root netshare/ module directly the way code-docker's own
# Dockerfile does. Unlike envmigrate/ (a real Go module `go mod vendor`
# materializes automatically, see vendor-envmigrate.sh), there's no package
# manager for a handful of sourced shell functions, so this just hand-copies
# netshare/*.sh into each subtree's own script/netshare/ - a real, committed
# copy, same spirit as `go mod vendor`'s output.
#
# Run this after editing anything under netshare/, before `docker compose
# build` (or `docker compose build code-docker-netinit code-docker-dind`) -
# there's no build-time staleness check for a plain file copy like there is
# for vendor-envmigrate.sh's `go mod vendor`, so forgetting this step is a
# silent staleness bug, not a build error. Keep it that way in mind until
# this becomes a real git submodule (see root CLAUDE.md's "netshare"
# section) - shared with code-server-autoinstall's own vendoring approach.
cd "$(dirname "$0")"

for target in netinit/script code-dind/script; do
    rm -rf "$target/netshare"
    mkdir -p "$target/netshare"
    cp netshare/*.sh "$target/netshare/"
done

echo "vendor-netshare: netinit/script/netshare and code-dind/script/netshare refreshed"
