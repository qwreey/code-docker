#!/bin/sh
set -u

# code-docker-internal is `internal: true`, so Docker's own embedded DNS
# (127.0.0.11) refuses to forward queries externally - a Docker feature, not
# a bug, but it means code-docker can't resolve any hostname via its default
# resolver. router runs a real forwarder (dnsmasq, see
# router/.claude/router-dns-plan.md) - this loop points /etc/resolv.conf at
# it via apply_nameserver, re-resolving `router`'s own IP periodically,
# since docker-compose's own `dns:` field only accepts a static IP and
# router's IP isn't static across recreates.
#
# entrypoint.sh also does this once, synchronously, before user-init.sh runs
# (so its own qwreey-fish curl has working DNS) - this program is what keeps
# it correct for the rest of the container's life (router recreated with a
# new IP, etc). apply_nameserver is shared with script/entrypoint.sh and
# code-dind/script/dind-entrypoint.sh - see root CLAUDE.md's "netshare"
# section.

. /etc/code-docker/netshare/apply-nameserver.sh

trap 'exit 0' TERM INT

if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
    echo "resolv-writer: NETGATE_ENABLED=false, idling without touching /etc/resolv.conf"
    while true; do sleep 3600; done
fi

router_hostname="${ROUTER_HOSTNAME:-router}"

while true; do
    apply_nameserver "$router_hostname"
    sleep 5
done
