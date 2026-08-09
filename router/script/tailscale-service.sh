#!/bin/bash
set -e

if [ -e /etc/router/tailscale-service.override.sh ]; then
    exec /etc/router/tailscale-service.override.sh
else
    exec /etc/router/tailscale-service.default.sh
fi
