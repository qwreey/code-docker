#!/bin/bash
set -e

. /etc/code-docker/netshare/wait-until.sh
. /etc/code-docker/netshare/apply-nameserver.sh

# Phase 1 of egress-netgate-plan.md's outbound lockdown: this container has
# zero NET_ADMIN of its own (unlike the old code-docker-netinit sidecar,
# which shared this netns and held NET_ADMIN - see
# .claude/backlog/netinit-docker-plan.md). The default route toward netgate
# is instead planted from *outside* this netns by the host-side
# code-docker-netinit-docker agent (nsenter into this container's SandboxKey
# - see docker-compose.yml and root CLAUDE.md's "docker-compose topology"
# section) - wait for it here, before anything below does anything
# network-sensitive (starting with user-init.sh's qwreey-fish curl). No
# cyclic compose dependency needed for this - reading the route table needs
# no capability, only setting it does (see the plan doc's "순환 의존성 걱정"
# for why this is a plain poll here and not a `depends_on`).
# Skippable via NETGATE_ENABLED=false for hosts that opted out of the whole
# feature (see example-env) - nothing will ever set this route in that
# case, so waiting on it would hang forever.
if [ "${NETGATE_ENABLED:-true}" != "false" ]; then
    if ! wait_until "netinit-docker's default route" 60 2 sh -c 'ip route show default 2>/dev/null | grep -q .'; then
        echo >&2 "entrypoint: no default route after 60s - code-docker-netinit-docker never planted one. Exiting so restart: unless-stopped retries."
        exit 1
    fi

    # code-docker-internal is `internal: true`, so Docker's own embedded DNS
    # (127.0.0.11) refuses to forward queries externally - router runs a real
    # forwarder instead (see router/.claude/router-dns-plan.md). Do this
    # once, synchronously, before user-init.sh's own qwreey-fish curl below,
    # as a short-lived bootstrap: it's the same plain "127.0.0.11 then
    # router" resolv.conf shape that only some resolvers fail over past
    # correctly (see .claude/backlog/dns-local-servfail-fix.md), good enough
    # for the tools user-init.sh itself uses (curl, glibc-based, correctly
    # fails over), but not a permanent fix. The dns-local supervisord program
    # (config/dns-local/dns-local.default.sh) supersedes this moments later
    # with a real local resolver and rewrites /etc/resolv.conf again once
    # it's up - it can't run this early itself since it doesn't start until
    # supervisord does, which is after user-init.sh already ran.
    # `getent hosts "$router_hostname"` itself doesn't need this rewrite
    # yet - Docker's embedded DNS already resolves same-network container/
    # alias names regardless of the internal-network restriction, only
    # external forwarding is blocked. apply_nameserver is shared with
    # code-dind/script/dind-entrypoint.sh - see root CLAUDE.md's "netshare"
    # section.
    router_hostname="${ROUTER_HOSTNAME:-router}"
    if wait_until "router's DNS forwarder" 60 2 getent hosts "$router_hostname"; then
        apply_nameserver "$router_hostname"
    else
        echo >&2 "entrypoint: could not resolve '$router_hostname' after 60s - continuing without DNS, dns-local will keep retrying once supervisord starts"
    fi
fi

# Init runtime dir
mkdir -p /run/xdg && chmod 700 /run/xdg
export XDG_RUNTIME_DIR=/run/xdg

# docker-compose.yml passes these in as CODE_TZ/CODE_LANG, not TZ/LANG directly -
# see that file's own comment on why. Re-export under the real names so glibc/date/
# supervisord and everything it spawns below (user-init.sh included) pick them up
# the normal way.
export TZ="${CODE_TZ:-}"
export LANG="${CODE_LANG:-}"

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
