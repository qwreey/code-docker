#!/bin/bash

export HOME="/code"

if [ ! -e /code/.installed ]; then
    if [ -e /install/user-override.sh ]; then
        /install/user-override.sh
    else
        /install/user-default.sh
    fi
    touch /code/.installed
fi

mkdir -p /code/.server
TARGET="/code/.server" /install/code/install.sh
if [ ! -e "/code/.server/config.yaml" ]; then
    if [ -e /install/code-override.yaml ]; then
        cp /install/code-override.yaml /code/.server/config.yaml
    else
        cp /install/code-default.yaml /code/.server/config.yaml
    fi
fi

if [ -e "/install/start-override.sh" ]; then
    /install/start-override.sh
else
    /install/start-default.sh
fi
