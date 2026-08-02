#!/bin/bash
set -e

if [ -e /etc/code-docker/tailscale-status.override.sh ]; then
    exec /etc/code-docker/tailscale-status.override.sh
else
    exec /etc/code-docker/tailscale-status.default.sh
fi
