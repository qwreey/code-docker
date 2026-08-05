#!/bin/bash
set -e

# Phase 1 of egress-netgate-plan.md's outbound lockdown: code-docker-netinit
# (network_mode: service:code-docker, see docker-compose.yml) is the only
# thing in this container's netns with NET_ADMIN, and it's what plants the
# default route toward netgate - wait for it here, before anything below
# does anything network-sensitive (starting with user-init.sh's qwreey-fish
# curl). No cyclic compose dependency needed for this - reading the route
# table needs no capability, only setting it does (see the plan doc's "순환
# 의존성 걱정" for why this is a plain poll here and not a `depends_on`).
# Skippable via NETGATE_ENABLED=false for hosts that opted out of the whole
# feature (see example-env) - nothing will ever set this route in that
# case, so waiting on it would hang forever.
if [ "${NETGATE_ENABLED:-true}" != "false" ]; then
    echo "entrypoint: waiting for netinit to set a default route..."
    waited=0
    timeout=60
    interval=2
    until ip route show default 2>/dev/null | grep -q .; do
        waited=$((waited + interval))
        if [ "$waited" -ge "$timeout" ]; then
            echo >&2 "entrypoint: no default route after ${timeout}s - netinit/netgate never came up. This is EXPECTED until netgate (Phase 2) is deployed - see .claude/backlog/egress-netgate-plan.md. Exiting so restart: unless-stopped retries."
            exit 1
        fi
        sleep "$interval"
    done
    echo "entrypoint: default route present, continuing"
fi

# Init runtime dir
mkdir -p /run/xdg && chmod 700 /run/xdg
export XDG_RUNTIME_DIR=/run/xdg

# Run home-folder migrations before any supervisord program can touch $HOME
# - several programs below start at the same priority and would otherwise
# race user-init creating/moving their state dirs (see
# .claude/backlog/home-structure-plan.md). Not exec'd - this must return so
# supervisord can start next; a failure here trips `set -e` above and kills
# the container instead of continuing in a half-migrated state.
/etc/code-docker/user-init.sh

# Run supervisord
mkdir -p /code/.local
if [ -e /etc/code-docker/supervisord.override.conf ]; then
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.override.conf --user root
else
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.default.conf --user root
fi
