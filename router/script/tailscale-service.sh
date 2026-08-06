#!/bin/bash
set -e

if [ -e /etc/code-docker/tailscale-service.override.sh ]; then
    exec /etc/code-docker/tailscale-service.override.sh
else
    exec /etc/code-docker/tailscale-service.default.sh
fi
