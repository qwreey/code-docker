#!/bin/bash
set -e

if [ -e /etc/code-docker/tailscale-publish.override.sh ]; then
    exec /etc/code-docker/tailscale-publish.override.sh
else
    exec /etc/code-docker/tailscale-publish.default.sh
fi
