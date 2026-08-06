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

    # code-docker-internal is `internal: true`, so Docker's own embedded DNS
    # (127.0.0.11) refuses to forward queries externally - router runs a real
    # forwarder instead (see router/.claude/router-dns-plan.md). Do this
    # once, synchronously, before user-init.sh's own qwreey-fish curl below -
    # the resolv-writer supervisord program (config/resolv-writer.default.sh)
    # keeps /etc/resolv.conf correct for the rest of this container's life
    # (e.g. if router gets recreated with a new IP), but that program doesn't
    # start until supervisord does, which is after user-init.sh already ran.
    # `getent hosts router` itself doesn't need this rewrite yet - Docker's
    # embedded DNS already resolves same-network container/alias names
    # regardless of the internal-network restriction, only external
    # forwarding is blocked.
    echo "entrypoint: waiting for router's DNS forwarder..."
    waited=0
    timeout=60
    interval=2
    router_ip=""
    until [ -n "$router_ip" ]; do
        router_ip="$(getent hosts router 2>/dev/null | awk '{ print $1; exit }')"
        [ -n "$router_ip" ] && break
        waited=$((waited + interval))
        if [ "$waited" -ge "$timeout" ]; then
            echo >&2 "entrypoint: could not resolve 'router' after ${timeout}s - continuing without DNS, resolv-writer will keep retrying once supervisord starts"
            break
        fi
        sleep "$interval"
    done
    if [ -n "$router_ip" ]; then
        # 127.0.0.11 (Docker's own embedded resolver) stays first - it's
        # still what resolves local container names/aliases (private,
        # router, dind, ...), unrelated to the internal-network
        # external-forwarding restriction this works around. router is
        # added as a fallback for names 127.0.0.11 won't/can't forward.
        printf 'nameserver 127.0.0.11\nnameserver %s\noptions ndots:0\n' "$router_ip" > /etc/resolv.conf
        echo "entrypoint: /etc/resolv.conf now has router ($router_ip) as fallback nameserver"
    fi
fi

# Init runtime dir
mkdir -p /run/xdg && chmod 700 /run/xdg
export XDG_RUNTIME_DIR=/run/xdg

# Run home-folder migrations before any supervisord program can touch $HOME
# - several programs below start at the same priority and would otherwise
# race user-init creating/moving their state dirs (see
# .claude/archive/home-structure-plan.md). Not exec'd - this must return so
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
