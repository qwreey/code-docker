#!/bin/bash
set -e

if [ -e /etc/code-docker/resolv-writer.override.sh ]; then
    exec /etc/code-docker/resolv-writer.override.sh
else
    exec /etc/code-docker/resolv-writer.default.sh
fi
