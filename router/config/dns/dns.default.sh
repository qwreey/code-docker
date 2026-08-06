#!/bin/sh
set -e

CONF=/etc/code-docker/dns/dnsmasq.default.conf
if [ -e /etc/code-docker/dns/dnsmasq.override.conf ]; then
    CONF=/etc/code-docker/dns/dnsmasq.override.conf
fi

# blocklist.override.hosts is an *additional* blocklist, not a replacement
# for the built-in one baked into dnsmasq.default.conf's own addn-hosts= -
# see dnsmasq.default.conf's comment on why that's the more natural idiom
# here than the old squid-era default/override "pick one" pattern.
if [ -e /etc/code-docker/dns/blocklist.override.hosts ]; then
    exec dnsmasq --conf-file="$CONF" --addn-hosts=/etc/code-docker/dns/blocklist.override.hosts
fi
exec dnsmasq --conf-file="$CONF"
