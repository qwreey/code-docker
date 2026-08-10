#!/bin/sh
set -u

# code-docker-internal is `internal: true`, so Docker's own embedded DNS
# (127.0.0.11) refuses to forward queries externally - a Docker feature, not
# a bug, but it means code-docker can't resolve any hostname via its default
# resolver. router runs a real forwarder (dnsmasq, see
# router/.claude/router-dns-plan.md) - this loop points /etc/resolv.conf at
# it, re-resolving `router`'s own IP periodically (same getent-in-a-loop
# pattern this script's own apply_default_route uses for the default route,
# since docker-compose's own `dns:` field only accepts a static IP, and
# router's IP isn't static across recreates).
#
# apply_default_route/apply_nameserver are shared with
# code-dind/script/dind-entrypoint.sh - see root CLAUDE.md's
# "netshare" section (code-docker's own ongoing DNS resolution now goes
# through config/dns-local/ instead of apply_nameserver, see
# .claude/backlog/dns-local-servfail-fix.md). This subtree's own isolated
# build context can't reach
# repo-root netshare/ directly, so /netshare here is a hand-synced copy
# (netinit/script/netshare/, run vendor-netshare.sh after editing
# netshare/).
. /netshare/apply-route.sh

trap 'exit 0' TERM INT

if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
	echo "netinit: NETGATE_ENABLED=false, idling without touching routes"
	while true; do sleep 3600; done
fi

router_hostname="${ROUTER_HOSTNAME:-router}"

while true; do
	# code-docker is the netns owner (network_mode: service:code-docker) -
	# if it restarts (not just a process inside it), Docker tears down and
	# recreates its network sandbox, orphaning this container in the old,
	# now-interfaceless namespace (moby/moby#50326 - confirmed to actually
	# happen in practice, not just theoretical, see the plan doc's "재시작
	# 복원력"). Only `lo` surviving means exactly that - no amount of
	# retrying `ip route replace` fixes it from inside a dead netns, so
	# exit non-zero and let `restart: unless-stopped` recreate this
	# container instead, which rejoins whatever netns code-docker currently
	# owns.
	if ! ip -o link show 2>/dev/null | grep -qv '^[0-9]*: lo:'; then
		echo >&2 "netinit: only loopback visible - code-docker's netns was likely recreated out from under us, exiting so restart: unless-stopped rejoins it"
		exit 1
	fi

	# router (formerly netgate) not resolving is the expected, permanent
	# state throughout Phase 1 (router itself doesn't exist yet - see
	# .claude/backlog/egress-netgate-plan.md). apply_default_route must
	# never be treated as fatal when it returns 1 here - a crash would
	# tear down code-docker's own netns setup for no benefit, since this
	# container only patches code-docker's routing table, it doesn't own
	# the netns.
	apply_default_route "$router_hostname"

	sleep 5
done
