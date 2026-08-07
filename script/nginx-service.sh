#!/bin/bash
set -e

if [ -e /etc/code-docker/nginx/nginx-service.override.sh ]; then
    exec /etc/code-docker/nginx/nginx-service.override.sh
else
    exec /etc/code-docker/nginx/nginx-service.default.sh
fi
