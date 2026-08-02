#!/bin/bash

# Run user init script
if [ -e /etc/code-docker/user-init.override.sh ]; then
    /etc/code-docker/user-init.override.sh
else
    /etc/code-docker/user-init.default.sh
fi

# Update code server
mkdir -p /code/.server
TARGET="/code/.server" /etc/code-docker/code-server-autoinstall/install.sh
if [ ! -e "/code/.server/config.yaml" ]; then
    if [ -e /etc/code-docker/code-config.override.yaml ]; then
        cp /etc/code-docker/code-config.override.yaml /code/.server/config.yaml
    else
        cp /etc/code-docker/code-config.default.yaml  /code/.server/config.yaml
    fi
fi

# source code env
if [ -e /etc/code-docker/code-env.override.sh ]; then
    source /etc/code-docker/code-env.override.sh
else
    source /etc/code-docker/code-env.default.sh
fi

# Run code-server in userenv
if [ -e /etc/code-docker/code-runner.override.sh ]; then
    exec /etc/code-docker/code-runner.override.sh
else
    exec /etc/code-docker/code-runner.default.sh
fi
