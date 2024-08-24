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
    if [ -e /install/code-config.override.yaml ]; then
        cp /install/code-config.override.yaml /code/.server/config.yaml
    else
        cp /install/code-config.default.yaml  /code/.server/config.yaml
    fi
fi

# source editor env
if [ -e /install/editor-env.override.sh ]; then
    source /install/editor-env.override.sh
else
    source /install/editor-env.default.sh
fi

# Run code-server in userenv
if [ -e /install/code-override-override.sh ]; then
    exec /install/code-override.override.sh
else
    exec /install/code-override.default.sh
fi
