#!/bin/bash
set -e

if [ -e /etc/router/tinyauth.override.sh ]; then
    exec /etc/router/tinyauth.override.sh
else
    exec /etc/router/tinyauth.default.sh
fi
