#!/bin/bash
set -e

if [ -e /etc/code-docker/tinyauth.override.sh ]; then
    exec /etc/code-docker/tinyauth.override.sh
else
    exec /etc/code-docker/tinyauth.default.sh
fi
