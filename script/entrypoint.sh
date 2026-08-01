#!/bin/bash
set -e

# Init runtime dir
mkdir -p /run/xdg && chmod 700 /run/xdg
export XDG_RUNTIME_DIR=/run/xdg

# Run supervisord
mkdir -p /code/.local
if [ -e /etc/code-docker/supervisord.override.conf ]; then
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.override.conf --user root
else
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.default.conf --user root
fi
