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
TARGET="/code/.server" /install/code-server-autoinstall/install.sh
TARGET="/code/.server" /install/code-server-autoinstall/start.sh
