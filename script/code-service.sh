#!/bin/bash
set -e

export PATH="/etc/code-docker/bin:$PATH"
if [ -e /etc/code-docker/code-service.override.sh ]; then
    exec /etc/code-docker/code-service.override.sh
else
    exec /etc/code-docker/code-service.default.sh
fi
