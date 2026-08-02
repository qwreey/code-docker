#!/bin/bash
set -e

export WEBMANAGER_STATIC_DIR=/etc/code-docker/webmanager/static
exec /etc/code-docker/webmanager/webmanager
