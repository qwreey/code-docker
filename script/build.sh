#!/bin/bash
set -e

if [ -e /etc/code-docker/build/build.override.sh ]; then
    exec /etc/code-docker/build/build.override.sh
else
    exec /etc/code-docker/build/build.default.sh
fi
