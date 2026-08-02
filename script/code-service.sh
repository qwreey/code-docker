#!/bin/bash
set -e

if [ -e /etc/code-docker/code-service.override.sh ]; then
    exec /etc/code-docker/code-service.override.sh
else
    exec /etc/code-docker/code-service.default.sh
fi
