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

exec /usr/local/bin/dockerd-entrypoint.sh dockerd \
	--host=unix:///var/run/docker.sock \
	--host="tcp://$internal_ip:2375" \
	"$@"
