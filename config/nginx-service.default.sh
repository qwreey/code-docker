#!/bin/bash
set -e

nginx_config=/etc/code-docker/nginx.default.conf
if [ -e /etc/code-docker/nginx.override.conf ]; then
    nginx_config=/etc/code-docker/nginx.override.conf
fi

exec nginx -g "daemon off;" -c "$nginx_config"
