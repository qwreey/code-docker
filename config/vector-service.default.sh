#!/bin/bash
set -e

mkdir -p /code/.vector/state /code/.vector/logs

vector_config=/etc/code-docker/vector.default.toml
if [ -e /etc/code-docker/vector.override.toml ]; then
    vector_config=/etc/code-docker/vector.override.toml
fi

exec /usr/bin/vector --config "$vector_config"
