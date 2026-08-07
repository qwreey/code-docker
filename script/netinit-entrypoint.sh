#!/bin/sh
set -u

# PID 1 with no explicit trap ignores SIGTERM by kernel default (this image
# is intentionally minimal - no dedicated init) - trap explicitly so
# `docker compose down`/stop exits immediately instead of waiting out the
# full SIGKILL grace period every time.
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

	gw_ip="$(getent hosts "$router_hostname" 2>/dev/null | awk '{ print $1; exit }')"

	# router (formerly netgate) not resolving is the expected, permanent
	# state throughout Phase 1 (router itself doesn't exist yet - see
	# .claude/backlog/egress-netgate-plan.md). This loop must never treat
	# that as fatal or exit non-zero - a crash here would tear down
	# code-docker's own netns setup for no benefit, since this container
	# only patches code-docker's routing table, it doesn't own the netns.
	if [ -n "$gw_ip" ]; then
		ip route replace default via "$gw_ip" 2>/dev/null
	fi

	# Best-effort watch for a second default route/gateway besides router.
	# Can't originate from inside code-docker itself (it has no NET_ADMIN
	# anywhere in its netns except this sidecar), so this only ever fires
	# from a deliberate compose/host edit (e.g. code-docker-external
	# re-attached) - detect + log only, never auto-revert someone's
	# intentional change. See the plan doc's "우리가 못 막는 것" 1.
	default_routes="$(ip -4 route show default 2>/dev/null)"
	line_count=$(printf '%s\n' "$default_routes" | grep -c '^default')
	unexpected=0
	if [ "$line_count" -gt 1 ]; then
		unexpected=1
	elif [ -n "$gw_ip" ] && [ -n "$default_routes" ] && ! printf '%s\n' "$default_routes" | grep -q "via $gw_ip"; then
		unexpected=1
	fi
	if [ "$unexpected" -eq 1 ]; then
		echo "netinit: WARNING unexpected default route(s), expected only $router_hostname ($gw_ip):" >&2
		printf '%s\n' "$default_routes" >&2
	fi

	sleep 5
done
