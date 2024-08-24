#!/bin/bash

mkdir -p /code/.local
if [ -e /install/supervisord.override.conf ]; then
    exec /sbin/supervisord -n -c /install/supervisord.override.conf --user root
else
    exec /sbin/supervisord -n -c /install/supervisord.default.conf --user root
fi
