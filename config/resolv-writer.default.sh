#!/bin/sh
set -u

# code-docker-internal is `internal: true`, so Docker's own embedded DNS
# (127.0.0.11) refuses to forward queries externally - a Docker feature, not
# a bug, but it means code-docker can't resolve any hostname via its default
# resolver. router runs a real forwarder (dnsmasq, see
# router/.claude/router-dns-plan.md) - this loop points /etc/resolv.conf at
# it, re-resolving `router`'s own IP periodically (same getent-in-a-loop
# pattern script/netinit-entrypoint.sh uses for the default route, since
# docker-compose's own `dns:` field only accepts a static IP, and router's IP
# isn't static across recreates).
#
# entrypoint.sh also does this once, synchronously, before user-init.sh runs
# (so its own qwreey-fish curl has working DNS) - this program is what keeps
# it correct for the rest of the container's life (router recreated with a
# new IP, etc).

trap 'exit 0' TERM INT

if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
    echo "resolv-writer: NETGATE_ENABLED=false, idling without touching /etc/resolv.conf"
    while true; do sleep 3600; done
fi

# 127.0.0.11 (Docker's own embedded resolver) is kept as the FIRST
# nameserver, not replaced - it's still what resolves local container
# names/aliases (private, router, dind, forward, tinyauth, ...), which have
# nothing to do with the internal-network external-forwarding restriction
# this whole mechanism works around. router's dnsmasq is added as a SECOND
# nameserver, tried on SERVFAIL - a name Docker's own resolver won't/can't
# forward externally falls through to it. Losing 127.0.0.11 entirely was
# tried first and broke nginx (couldn't resolve its own "private" upstream
# anymore) - see router/.claude/router-dns-plan.md.
# Written via direct redirect (truncate-in-place), not a tmp-file+mv swap -
# /etc/resolv.conf is a bind-mounted file (Docker's own per-container
# generated file), and `mv` onto a bind-mount target fails with
# "Resource busy" (rename() can't replace an active mount point). Writing
# into it directly works fine; the tiny non-atomic-write window doesn't
# matter for a file this short.
while true; do
    router_ip="$(getent hosts router 2>/dev/null | awk '{ print $1; exit }')"
    if [ -n "$router_ip" ] && ! grep -q "^nameserver $router_ip\$" /etc/resolv.conf 2>/dev/null; then
        printf 'nameserver 127.0.0.11\nnameserver %s\noptions ndots:0\n' "$router_ip" > /etc/resolv.conf \
            && echo "resolv-writer: /etc/resolv.conf now has router ($router_ip) as fallback nameserver"
    fi
    sleep 5
done
