#!/bin/bash
set -e

if [ -e /etc/code-docker/tailscale-forward.override.sh ]; then
    exec /etc/code-docker/tailscale-forward.override.sh
else
    exec /etc/code-docker/tailscale-forward.default.sh
fi
