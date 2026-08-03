#!/bin/bash
set -e

mkdir -p /code/.vector/state /code/.vector/logs

vector_config=/etc/code-docker/vector.default.toml
if [ -e /etc/code-docker/vector.override.toml ]; then
    vector_config=/etc/code-docker/vector.override.toml
fi

# VECTOR_LOG_LEVEL (docker-compose.yml) controls vector's own internal
# diagnostic verbosity (startup/healthcheck/file-watch chatter on its
# stdout), not the log pipeline data it carries (other programs' re-emitted
# stdout, /code/.vector/logs/*.jsonl) - see vector.default.toml for that.
export VECTOR_LOG="${VECTOR_LOG_LEVEL:-warn}"

exec /usr/bin/vector --config "$vector_config"
