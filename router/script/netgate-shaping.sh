#!/bin/bash
set -e

if [ -e /etc/router/netgate/shaping.override.sh ]; then
    exec /etc/router/netgate/shaping.override.sh
else
    exec /etc/router/netgate/shaping.default.sh
fi
