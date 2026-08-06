#!/bin/sh
set -e

if [ -e /etc/code-docker/dns/dns.override.sh ]; then
    exec /etc/code-docker/dns/dns.override.sh
else
    exec /etc/code-docker/dns/dns.default.sh
fi
