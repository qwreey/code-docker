#!/bin/bash
set -e

# Update code server
mkdir -p /code/.local/share/code-docker/code
TARGET="/code/.local/share/code-docker/code" /etc/code-docker/code-server-autoinstall/install.sh

# Regenerated every start (not just once) - this file is fully derived, same
# as every other override-pattern file. Customize via
# code-config.override.yaml + rebuild, never by hand-editing the copy under
# /code/.local/share/code-docker/code directly (it would just get overwritten
# on next start).
if [ -e /etc/code-docker/code/code-config.override.yaml ]; then
    cp /etc/code-docker/code/code-config.override.yaml /code/.local/share/code-docker/code/config.yaml
else
    cp /etc/code-docker/code/code-config.default.yaml  /code/.local/share/code-docker/code/config.yaml
fi

# Seed code-docker's own default browser patches. Runs every start, like
# user-init, but must come after install.sh so
# /code/.local/share/code-docker/code/patch exists.
if [ -e /etc/code-docker/code/code-patch.override.sh ]; then
    /etc/code-docker/code/code-patch.override.sh
else
    /etc/code-docker/code/code-patch.default.sh
fi

# Seed code-server's user settings.json if it doesn't exist yet. Must run
# before code-server starts (it creates the file lazily on first write), and
# after install.sh so the user-data dir's parent is there. Unlike code-patch
# above this is create-only, never a refresh - see that script's own comment
# for why settings.json can't use the hash-manifest scheme.
if [ -e /etc/code-docker/code/code-settings.override.sh ]; then
    /etc/code-docker/code/code-settings.override.sh
else
    /etc/code-docker/code/code-settings.default.sh
fi

# source code env
if [ -e /etc/code-docker/code/code-env.override.sh ]; then
    source /etc/code-docker/code/code-env.override.sh
else
    source /etc/code-docker/code/code-env.default.sh
fi

# Run code-server in userenv
if [ -e /etc/code-docker/code/code-runner.override.sh ]; then
    exec /etc/code-docker/code/code-runner.override.sh
else
    exec /etc/code-docker/code/code-runner.default.sh
fi
