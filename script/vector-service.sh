#!/bin/bash
set -e

if [ -e /etc/code-docker/vector/vector-service.override.sh ]; then
    exec /etc/code-docker/vector/vector-service.override.sh
else
    exec /etc/code-docker/vector/vector-service.default.sh
fi
