#!/bin/sh
set -e

if [ -e /etc/code-docker/dns/dnsmasq.override.conf ]; then
    exec dnsmasq --conf-file=/etc/code-docker/dns/dnsmasq.override.conf
else
    exec dnsmasq --conf-file=/etc/code-docker/dns/dnsmasq.default.conf
fi
