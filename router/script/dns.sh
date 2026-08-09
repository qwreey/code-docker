#!/bin/sh
set -e

if [ -e /etc/router/dns/dns.override.sh ]; then
    exec /etc/router/dns/dns.override.sh
else
    exec /etc/router/dns/dns.default.sh
fi
