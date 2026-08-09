#!/bin/bash
set -e

if [ -e /etc/router/tailscale-forward.override.sh ]; then
    exec /etc/router/tailscale-forward.override.sh
else
    exec /etc/router/tailscale-forward.default.sh
fi
