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

# authz_arg is deliberately unquoted below: it's either empty or a single
# well-known flag, and dockerd needs it word-split, not passed as one
# (possibly empty) argument.
exec /usr/local/bin/dockerd-entrypoint.sh dockerd \
	--host=unix:///var/run/docker.sock \
	--host="tcp://$internal_ip:2375" \
	$authz_arg \
	"$@"
