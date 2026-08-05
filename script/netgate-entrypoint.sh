#!/bin/sh
set -eu

# Same behavioral-opt-out pattern as TAILSCALE_ENABLED/NETGATE_ENABLED
# elsewhere in this repo (see CLAUDE.md's "egress lockdown (netgate)") -
# code-docker/dind's own routing loops already idle when this is "false", so
# there's nothing useful for netgate itself to do either: no traffic will
# ever arrive here to filter or forward.
if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
	echo "netgate: NETGATE_ENABLED=false, idling without applying any firewall/proxy rules"
	exec sleep infinity
fi

if [ -e /etc/code-docker/netgate/supervisord.override.conf ]; then
	exec /sbin/supervisord -n -c /etc/code-docker/netgate/supervisord.override.conf --user root
else
	exec /sbin/supervisord -n -c /etc/code-docker/netgate/supervisord.default.conf --user root
fi
