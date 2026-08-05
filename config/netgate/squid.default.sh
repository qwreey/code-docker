#!/bin/sh
set -eu

# supervisord program (see config/netgate/supervisord.default.conf).

SQUID_CONF_SRC=/etc/code-docker/netgate/squid.default.conf
if [ -e /etc/code-docker/netgate/squid.override.conf ]; then
	SQUID_CONF_SRC=/etc/code-docker/netgate/squid.override.conf
fi

BLOCKLIST=/etc/code-docker/netgate/blocklist.default.acl
if [ -e /etc/code-docker/netgate/blocklist.override.acl ]; then
	BLOCKLIST=/etc/code-docker/netgate/blocklist.override.acl
fi

export NETGATE_BLOCKLIST_PATH="$BLOCKLIST"
envsubst '${NETGATE_BLOCKLIST_PATH}' <"$SQUID_CONF_SRC" >/etc/squid/squid.conf

exec squid -N -f /etc/squid/squid.conf
