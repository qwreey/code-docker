#!/bin/bash
set -e

if [ -e /etc/code-docker/dns-local/dns-local.override.sh ]; then
    exec /etc/code-docker/dns-local/dns-local.override.sh
else
    exec /etc/code-docker/dns-local/dns-local.default.sh
fi
