#!/bin/bash
set -e

if [ -e /etc/code-docker/netgate/squid.override.sh ]; then
    exec /etc/code-docker/netgate/squid.override.sh
else
    exec /etc/code-docker/netgate/squid.default.sh
fi
