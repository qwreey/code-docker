#!/bin/bash
set -e

if [ -e /etc/code-docker/netgate/firewall.override.sh ]; then
    exec /etc/code-docker/netgate/firewall.override.sh
else
    exec /etc/code-docker/netgate/firewall.default.sh
fi
