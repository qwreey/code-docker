#!/bin/bash

# If user not inited
if [ ! -e /code/.installed ]; then
    if [ -e /install/user-override.sh ]; then
        /install/user-override.sh
    else
        /install/user-default.sh
    fi
    touch /code/.installed
fi

# Update code server
mkdir -p /code/.server
TARGET="/code/.server" /install/code/install.sh
if [ ! -e "/code/.server/config.yaml" ]; then
    if [ -e /install/code-override.yaml ]; then
        cp /install/code-override.yaml /code/.server/config.yaml
    else
        cp /install/code-default.yaml /code/.server/config.yaml
    fi
fi

# Run code-server in userenv
exec env TARGET="/code/.server" /code/.zsh/userenv /install/code/start.sh
