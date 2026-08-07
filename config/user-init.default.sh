#!/bin/bash
set -e

export HOME="/code"

CURR_VERSION=1
UMBRELLA="/code/.local/share/code-docker"
VERSION_FILE="$UMBRELLA/migration-version"
LEGACY_VERSION_FILE="/code/.installed"

mkdir -p "$UMBRELLA"

# Absorb the pre-umbrella version marker in place (mv, not read-and-leave) -
# otherwise the very file this migration exists to clean up would linger in
# $HOME forever. A container that already has this means first-time setup
# below already ran once, just before $UMBRELLA existed.
if [ ! -e "$VERSION_FILE" ] && [ -e "$LEGACY_VERSION_FILE" ]; then
    mv "$LEGACY_VERSION_FILE" "$VERSION_FILE"
fi

# First time init migration
if [ ! -e "$VERSION_FILE" ]; then
    # qs_setup's fisher installs can leave fish's $status non-zero even when
    # everything installed fine - some third-party plugins pulled in here
    # (e.g. puffer-fish, autopair.fish) start their conf.d hook with
    # `status is-interactive || exit`, a correct guard that no-ops key
    # bindings in a non-interactive shell, but which fish -c below still
    # sees as this call's own non-zero exit status. Don't let that trip
    # set -e and crash-loop the whole container on every boot - log it and
    # move on, since the actual install (visible above in the logs either
    # way) already happened.
    fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null \
        || echo "user-init: qs_setup exited non-zero (see comment above) - continuing anyway" >&2
    echo "$CURR_VERSION" > "$VERSION_FILE"
fi
if [ "x$(cat "$VERSION_FILE")x" = "xx" ]; then
    echo "1" > "$VERSION_FILE"
fi

OLD_VERSION="$(cat "$VERSION_FILE")"

# Future versioned migration steps go here, each gated on
# `[ "$OLD_VERSION" -lt N ]` and safe to leave in place indefinitely once
# shipped (see .claude/archive/home-structure-plan.md for the pattern this
# follows - the home-directory consolidation it originally introduced was
# retired here once every container that needed it had migrated).

if [ "$OLD_VERSION" != "$CURR_VERSION" ]; then
    echo "$CURR_VERSION" > "$VERSION_FILE"
fi

# No xdg-user-dirs (or equivalent) runs in this container - there's no DE/
# browser to populate Desktop/Documents/Downloads for, so those aren't worth
# creating. Projects is different: webmanager's Projects tab defaults to
# scanning $HOME/Projects (WEBMANAGER_PROJECTS_PATH) but silently shows
# nothing if it's missing, with no prompt telling a new user to create it -
# ensure it exists instead. Unconditional/idempotent, not version-gated.
mkdir -p /code/Projects
