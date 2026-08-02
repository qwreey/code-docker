#!/bin/bash
set -e

if [ -e /etc/code-docker/webmanager.override.sh ]; then
    exec /etc/code-docker/webmanager.override.sh
else
    exec /etc/code-docker/webmanager.default.sh
fi
