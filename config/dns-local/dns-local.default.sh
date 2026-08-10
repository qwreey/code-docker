#!/bin/sh
set -u

# Fixes a getaddrinfo ESERVFAIL class of bug: code-docker-internal is
# `internal: true`, so Docker's own embedded DNS (127.0.0.11) refuses to
# forward any name it doesn't already own with a definitive SERVFAIL
# instead of a timeout - it still needs to be consulted first, since it's
# what resolves same-network aliases like `router`/`dind`. The resolv.conf
# this replaced (127.0.0.11 first, router second as a plain fallback
# nameserver, written by the old resolv-writer program + apply_nameserver)
# only worked for clients whose resolver actually retries the next
# nameserver after a *definitive* SERVFAIL - glibc's own NSS stack does
# (`getent`), but plain `dig` and Claude Code's own Node runtime don't, and
# just report the first server's SERVFAIL straight back to the caller
# (empirically confirmed, not just suspected - see the investigation this
# fix came out of).
#
# The fix: run a local dnsmasq in --strict-order mode as the *only*
# nameserver code-docker itself ever talks to (127.0.0.1). strict-order
# dnsmasq itself *does* retry the next --server= entry on SERVFAIL
# (confirmed empirically against this exact 127.0.0.11-then-router setup),
# so the failover now happens once, correctly, inside dnsmasq - every
# client downstream just sees one nameserver and either gets a real answer
# or a real failure, never a spurious SERVFAIL from a server that simply
# doesn't own the name it was asked about.
#
# code-docker-dind has the same underlying resolv.conf shape (see
# netshare/apply-nameserver.sh) and is very likely exposed to the same
# class of bug, but isn't fixed by this - see
# .claude/backlog/dns-local-servfail-fix.md's "code-docker-dind" section
# for the deferred follow-up plan.

. /etc/code-docker/netshare/wait-until.sh

if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
    echo "dns-local: NETGATE_ENABLED=false, idling without starting a local resolver"
    while true; do sleep 3600; done
fi

ROUTER_HOSTNAME="${ROUTER_HOSTNAME:-router}"
RUN_DIR=/run/code-docker
mkdir -p "$RUN_DIR"

DNSMASQ_PID=""
LAST_ROUTER_IP=""

# Restarting dnsmasq (rather than SIGHUP-reloading a --servers-file) on a
# router IP change is deliberately simple: this only happens when router
# itself gets recreated, a rare event, and a ~1s DNS blip during the swap
# is an acceptable trade for not depending on --servers-file's SIGHUP
# reload semantics, which weren't verified as part of this fix.
start_dnsmasq() {
    router_ip="$(getent hosts "$ROUTER_HOSTNAME" 2>/dev/null | awk '{ print $1; exit }')"
    [ -z "$router_ip" ] && return 1
    dnsmasq --no-daemon --no-resolv --strict-order \
        --listen-address=127.0.0.1 --bind-interfaces \
        --server=127.0.0.11 --server="$router_ip" \
        --pid-file="$RUN_DIR/dns-local.pid" &
    DNSMASQ_PID=$!
    LAST_ROUTER_IP="$router_ip"
}

trap 'kill "$DNSMASQ_PID" 2>/dev/null; exit 0' TERM INT

wait_until "router's DNS forwarder" 60 2 getent hosts "$ROUTER_HOSTNAME" \
    || echo >&2 "dns-local: could not resolve '$ROUTER_HOSTNAME' after 60s - starting anyway, will keep retrying"

until start_dnsmasq; do
    sleep 2
done

# A bind failure (port 53 already taken, etc) makes dnsmasq exit almost
# immediately - a short pause then checking it's still alive is a good
# enough proxy for "started cleanly" without needing a real query round-trip.
sleep 1
if kill -0 "$DNSMASQ_PID" 2>/dev/null; then
    # Direct redirect (truncate-in-place), not tmp-file+mv - /etc/resolv.conf
    # is a bind-mounted file, and `mv` onto a bind-mount target fails with
    # "Resource busy" (same reason netshare/apply-nameserver.sh avoids it).
    printf 'nameserver 127.0.0.1\noptions ndots:0\n' > /etc/resolv.conf
    echo "dns-local: /etc/resolv.conf now points at the local resolver (router=$LAST_ROUTER_IP)"
else
    echo >&2 "dns-local: dnsmasq failed to start, leaving /etc/resolv.conf untouched"
fi

while true; do
    sleep 5
    router_ip="$(getent hosts "$ROUTER_HOSTNAME" 2>/dev/null | awk '{ print $1; exit }')"
    if [ -n "$router_ip" ] && [ "$router_ip" != "$LAST_ROUTER_IP" ]; then
        echo "dns-local: router IP changed ($LAST_ROUTER_IP -> $router_ip), restarting local resolver"
        kill "$DNSMASQ_PID" 2>/dev/null
        wait "$DNSMASQ_PID" 2>/dev/null
        start_dnsmasq
    fi
done
