#!/bin/sh
set -eu

# NETGATE_ENABLED's own opt-out check moved to firewall.default.sh - this
# script used to idle the ENTIRE router container (never starting
# supervisord at all) when NETGATE_ENABLED=false, which also silently took
# down DNS/tailscale/Dev Proxy/tinyauth/router-manager along with egress
# filtering, unlike TAILSCALE_ENABLED/CADDY_ADAPTER_ENABLED which only ever
# idle their own program. See root CLAUDE.md's code-quality audit and
# firewall.default.sh's own comment on its new check.

if [ -e /etc/router/netgate/supervisord.override.conf ]; then
	exec /sbin/supervisord -n -c /etc/router/netgate/supervisord.override.conf --user root
else
	exec /sbin/supervisord -n -c /etc/router/netgate/supervisord.default.conf --user root
fi
