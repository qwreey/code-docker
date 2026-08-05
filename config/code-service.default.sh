#!/bin/bash

# Update code server
mkdir -p /code/.local/share/code-docker/code
TARGET="/code/.local/share/code-docker/code" /etc/code-docker/code-server-autoinstall/install.sh

# Regenerated every start (not just once) - this file is fully derived, same
# as every other override-pattern file. Customize via
# code-config.override.yaml + rebuild, never by hand-editing the copy under
# /code/.local/share/code-docker/code directly (it would just get overwritten
# on next start).
if [ -e /etc/code-docker/code-config.override.yaml ]; then
    cp /etc/code-docker/code-config.override.yaml /code/.local/share/code-docker/code/config.yaml
else
    cp /etc/code-docker/code-config.default.yaml  /code/.local/share/code-docker/code/config.yaml
fi

# Seed code-docker's own default browser patches. Runs every start, like
# user-init, but must come after install.sh so
# /code/.local/share/code-docker/code/patch exists.
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
