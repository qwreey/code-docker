#!/bin/bash
set -e

if [ -e /etc/code-docker/vector-service.override.sh ]; then
    exec /etc/code-docker/vector-service.override.sh
else
    exec /etc/code-docker/vector-service.default.sh
fi
