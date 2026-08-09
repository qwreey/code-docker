#!/bin/bash
set -e

if [ -e /etc/router/caddy-adapter.override.sh ]; then
    exec /etc/router/caddy-adapter.override.sh
else
    exec /etc/router/caddy-adapter.default.sh
fi
