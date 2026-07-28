#!/bin/bash
set -e

if [ -e /etc/code-docker/build.override.sh ]; then
    exec /etc/code-docker/build.override.sh
else
    exec /etc/code-docker/build.default.sh
fi
