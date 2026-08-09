#!/bin/bash
set -e

if [ -e /etc/router/tailscale-publish.override.sh ]; then
    exec /etc/router/tailscale-publish.override.sh
else
    exec /etc/router/tailscale-publish.default.sh
fi
