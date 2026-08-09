#!/bin/bash
set -e

if [ -e /etc/router/nginx-service.override.sh ]; then
    exec /etc/router/nginx-service.override.sh
else
    exec /etc/router/nginx-service.default.sh
fi
