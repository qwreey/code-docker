#!/bin/bash
set -e

if [ -e /etc/code-docker/user-init.override.sh ]; then
    exec /etc/code-docker/user-init.override.sh
else
    exec /etc/code-docker/user-init.default.sh
fi
