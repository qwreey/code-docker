#!/bin/sh
set -eu

# The stock docker:dind entrypoint (dockerd-entrypoint.sh) hardcodes
# --host=tcp://0.0.0.0:2375, exposing the daemon on every interface
# (including code-docker-external). We want it reachable only from
# code-docker-internal instead.
#
# The container's IP on that network isn't known ahead of time (Docker
# assigns it from an auto-allocated subnet), so we can't hardcode it.
# Instead we pick it dynamically: code-docker-internal is the only
# network here with no route to the outside world, so we bind to
# whichever interface is NOT part of the default route.
#
# NOTE: this assumes exactly two networks (one with a route out, one
# without). If a third network is ever added to this service, this
# picks the first non-default, non-loopback interface it finds, which
# may need to become more specific at that point.
default_iface="$(ip -4 route show default 2>/dev/null | awk '{ print $5; exit }')"

internal_ip=""
for dev in /sys/class/net/*; do
	dev="$(basename "$dev")"
	[ "$dev" = "lo" ] && continue
	[ "$dev" = "$default_iface" ] && continue
	ip_addr="$(ip -4 -o addr show dev "$dev" 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1 | head -n1)"
	if [ -n "$ip_addr" ]; then
		internal_ip="$ip_addr"
		break
	fi
done

if [ -z "$internal_ip" ]; then
	echo >&2 "dind-entrypoint: couldn't find a non-default-route interface, falling back to 0.0.0.0:2375"
	internal_ip="0.0.0.0"
fi

# dind-authz (see Dockerfile's dind-authz stage) is only present on that
# stage's image, not on the plain dind stage - self-detect rather than
# needing a separate entrypoint script per stage.
authz_arg=""
if [ -x /usr/local/bin/dind-authz ]; then
	mkdir -p /etc/docker/plugins /run/docker/plugins /etc/dind-authz.d
	/usr/local/bin/dind-authz \
		-socket=/run/docker/plugins/dind-authz.sock \
		-policy-dirs=/etc/dind-authz-defaults.d,/etc/dind-authz.d &

	echo "unix:///run/docker/plugins/dind-authz.sock" >/etc/docker/plugins/dind-authz.spec

	waited=0
	while [ ! -S /run/docker/plugins/dind-authz.sock ]; do
		waited=$((waited + 1))
		if [ "$waited" -ge 10 ]; then
			echo >&2 "dind-entrypoint: dind-authz did not come up in time, aborting"
			exit 1
		fi
		sleep 1
	done

	authz_arg="--authorization-plugin=dind-authz"
fi

# DIND_USERNS_REMAP is only set (via ENV) on the dind-authz-remap stage -
# self-detect the same way as dind-authz above.
userns_arg=""
if [ -n "${DIND_USERNS_REMAP:-}" ]; then
	userns_arg="--userns-remap=$DIND_USERNS_REMAP"
fi

# Phase 1 of egress-netgate-plan.md's outbound lockdown (see the plan doc's
# dind section). dind already has NET_ADMIN via `privileged: true`, so
# unlike code-docker it manages its own default route directly instead of
# needing a netinit sidecar - same defensive loop as
# script/netinit-entrypoint.sh, just running against dind's own netns. Also
# keeps dind's own /etc/resolv.conf pointed at router's DNS forwarder for the
# same reason code-docker's resolv-writer program does (see
# .claude/backlog/router-dns-plan.md) - code-docker-internal being
# `internal: true` blocks Docker's own embedded DNS from forwarding
# externally, and dind needs real DNS too (pulling images by registry
# hostname).
if [ "${NETGATE_ENABLED:-true}" != "false" ]; then
	(
		trap 'exit 0' TERM INT
		while true; do
			gw_ip="$(getent hosts router 2>/dev/null | awk '{ print $1; exit }')"
			if [ -n "$gw_ip" ]; then
				ip route replace default via "$gw_ip" 2>/dev/null

				# Direct redirect (truncate-in-place), not tmp-file+mv - see
				# config/resolv-writer.default.sh's comment on why: `mv`
				# onto the bind-mounted /etc/resolv.conf fails with
				# "Resource busy".
				if ! grep -q "^nameserver $gw_ip\$" /etc/resolv.conf 2>/dev/null; then
					printf 'nameserver 127.0.0.11\nnameserver %s\noptions ndots:0\n' "$gw_ip" > /etc/resolv.conf
				fi
			fi

			default_routes="$(ip -4 route show default 2>/dev/null)"
			line_count=$(printf '%s\n' "$default_routes" | grep -c '^default')
			unexpected=0
			if [ "$line_count" -gt 1 ]; then
				unexpected=1
			elif [ -n "$gw_ip" ] && [ -n "$default_routes" ] && ! printf '%s\n' "$default_routes" | grep -q "via $gw_ip"; then
				unexpected=1
			fi
			if [ "$unexpected" -eq 1 ]; then
				echo "dind-entrypoint: WARNING unexpected default route(s), expected only router ($gw_ip):" >&2
				printf '%s\n' "$default_routes" >&2
			fi

			sleep 5
		done
	) &
fi

# authz_arg/userns_arg are deliberately unquoted below: each is either
# empty or a single well-known flag, and dockerd needs them word-split, not
# passed as one (possibly empty) argument.
#
# tini (not a bare exec of dockerd-entrypoint.sh) because dockerd becomes
# PID 1 the moment this exec happens - PID 1 must reap reparented zombies,
# and the routing loop backgrounded above forks `ip`/`getent` every 5s
# forever. dockerd itself doesn't do that reaping, tini does (and still
# forwards signals correctly, so `docker compose stop`'s SIGTERM reaches
# dockerd exactly as before).
exec tini -- /usr/local/bin/dockerd-entrypoint.sh dockerd \
	--host=unix:///var/run/docker.sock \
	--host="tcp://$internal_ip:2375" \
	$authz_arg \
	$userns_arg \
	"$@"
