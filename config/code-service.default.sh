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

# Regenerated every start (not just once) - this file is fully derived, same
# as every other override-pattern file. Customize via
# code-config.override.yaml + rebuild, never by hand-editing the copy under
# /code/.server directly (it would just get overwritten on next start).
if [ -e /etc/code-docker/code-config.override.yaml ]; then
    cp /etc/code-docker/code-config.override.yaml /code/.server/config.yaml
else
    cp /etc/code-docker/code-config.default.yaml  /code/.server/config.yaml
fi

# Seed code-docker's own default browser patches. Runs every start, like
# user-init, but must come after install.sh so /code/.server/patch exists.
if [ -e /etc/code-docker/code-patch.override.sh ]; then
    /etc/code-docker/code-patch.override.sh
else
    /etc/code-docker/code-patch.default.sh
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
