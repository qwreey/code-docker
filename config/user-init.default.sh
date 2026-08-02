#!/bin/bash

export HOME="/code"

CURR_VERSION=1

# First time init migration
if ! [ -e /code/.installed ]; then
    fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null
    echo "$CURR_VERSION" > /code/.installed
fi
if [ "x$(cat /code/.installed)x" = "xx" ]; then
    echo "1" > /code/.installed
fi

# Seed the tailscale sign-in notification patch (code-server-autoinstall
# injects every /code/.server/patch/*.js as a <script> on the workbench page,
# see tailscale-forward.default.sh for the status.json it polls). Only
# copied if missing, so user edits survive across restarts.
mkdir -p /code/.server/patch
if [ ! -e /code/.server/patch/tailscale-notify.js ]; then
    if [ -e /etc/code-docker/tailscale-notify.override.js ]; then
        cp /etc/code-docker/tailscale-notify.override.js /code/.server/patch/tailscale-notify.js
    else
        cp /etc/code-docker/tailscale-notify.default.js /code/.server/patch/tailscale-notify.js
    fi
fi
