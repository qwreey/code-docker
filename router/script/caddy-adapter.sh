#!/bin/bash
set -e

if [ -e /etc/code-docker/caddy-adapter.override.sh ]; then
    exec /etc/code-docker/caddy-adapter.override.sh
else
    exec /etc/code-docker/caddy-adapter.default.sh
fi
