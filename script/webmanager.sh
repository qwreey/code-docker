#!/bin/bash
set -e

if [ -e /etc/code-docker/webmanager/webmanager.override.sh ]; then
    exec /etc/code-docker/webmanager/webmanager.override.sh
else
    exec /etc/code-docker/webmanager/webmanager.default.sh
fi
