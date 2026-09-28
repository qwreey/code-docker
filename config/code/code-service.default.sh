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
cp "$(/etc/code-docker/override path code/code-config.default.yaml)" /code/.local/share/code-docker/code/config.yaml

# Seed code-docker's own default browser patches. Runs every start, like
# user-init, but must come after install.sh so
# /code/.local/share/code-docker/code/patch exists.
/etc/code-docker/override exec code/code-patch.default.sh

# Seed code-server's user settings.json if it doesn't exist yet. Must run
# before code-server starts (it creates the file lazily on first write), and
# after install.sh so the user-data dir's parent is there. Unlike code-patch
# above this is create-only, never a refresh - see that script's own comment
# for why settings.json can't use the hash-manifest scheme.
/etc/code-docker/override exec code/code-settings.default.sh

# Keep the built-in webmanager extension at this image's build. Non-
# essential: a failure warns and code-server starts anyway.
if ! /etc/code-docker/override exec code/code-extensions.default.sh; then
    echo "WARN: code-extensions sync failed - continuing without it"
fi

# source code env
source "$(/etc/code-docker/override path code/code-env.default.sh)"

# Run code-server in userenv
exec /etc/code-docker/override exec code/code-runner.default.sh
