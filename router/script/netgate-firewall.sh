#!/bin/bash
set -e

if [ -e /etc/router/netgate/firewall.override.sh ]; then
    exec /etc/router/netgate/firewall.override.sh
else
    exec /etc/router/netgate/firewall.default.sh
fi
