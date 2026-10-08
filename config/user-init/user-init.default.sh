#!/bin/bash
set -e

export HOME="/code"

CURR_VERSION=1
UMBRELLA="/code/.local/share/code-docker"
VERSION_FILE="$UMBRELLA/migration-version"
LEGACY_VERSION_FILE="/code/.installed"

# qwreey-fish's qs_setup.fish, pinned by commit and sha256 - it runs as root,
# so a floating branch would turn one compromised GitHub account into a root
# RCE on every volume. That file pins everything it installs in turn (fisher
# and its plugins by commit, mise by release + sha256, mise tools by
# version), and --self below makes it install qwreey-fish itself at this same
# commit. Bump both values with ./dev-bump-qwreey-fish.sh, which shows the
# diff to review first; the bump then reaches existing volumes too (see
# QWREEY_FISH_APPLIED_FILE below).
QWREEY_FISH_QS_SETUP_SHA="c33d0836c940b36707566a870ec1888dc7c9296a"
QWREEY_FISH_QS_SETUP_SHA256="444e5dfa82f93e35ccad5cb0a45fe443bd468141b7fc368afbc43f0f4b220d1e"

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

# qwreey-fish: (re)run the pinned qs_setup whenever the pin differs from the
# commit last applied to this volume - a fresh volume, one set up by an older
# image (no record, or an older commit), or one whose last attempt failed.
# Without this, bumping the pin would only ever reach brand-new volumes.
# qs_setup is idempotent: it swaps whatever is installed to the pinned
# versions and leaves the rest of the user's fish config alone.
#
# The record is written only after qs_setup succeeded, so a failed step is
# retried on the next boot. Someone managing their shell by hand (e.g.
# following main with qs_update) opts out by creating
# QWREEY_FISH_MANUAL_FILE; otherwise the next pin bump would put them back
# on the pinned commit.
#
# Never fatal: qwreey-fish is a shell nicety, not a core service, so neither
# a failed download, a checksum mismatch nor a failed qs_setup trips set -e
# (each logs why instead - no silent skips).
QWREEY_FISH_APPLIED_FILE="$UMBRELLA/qwreey-fish-applied"
QWREEY_FISH_MANUAL_FILE="$UMBRELLA/qwreey-fish-manual"
QWREEY_FISH_APPLIED="$(cat "$QWREEY_FISH_APPLIED_FILE" 2>/dev/null || true)"
if [ -e "$QWREEY_FISH_MANUAL_FILE" ]; then
    if [ "$QWREEY_FISH_APPLIED" != "$QWREEY_FISH_QS_SETUP_SHA" ]; then
        echo "user-init: $QWREEY_FISH_MANUAL_FILE exists - not moving qwreey-fish to the pinned ${QWREEY_FISH_QS_SETUP_SHA:0:12} (delete that file to have it applied)"
    fi
elif [ "$QWREEY_FISH_APPLIED" != "$QWREEY_FISH_QS_SETUP_SHA" ]; then
    echo "user-init: qwreey-fish ${QWREEY_FISH_APPLIED:-(nothing recorded on this volume)} -> $QWREEY_FISH_QS_SETUP_SHA - running qs_setup"
    QS_SETUP_URL="https://raw.githubusercontent.com/qwreey/qwreey-fish/${QWREEY_FISH_QS_SETUP_SHA}/functions/qs_setup.fish"
    QS_SETUP_TMP="$(mktemp)"
    if curl -fsSL "$QS_SETUP_URL" -o "$QS_SETUP_TMP"; then
        QS_SETUP_ACTUAL_SHA256="$(sha256sum "$QS_SETUP_TMP" | awk '{ print $1 }')"
        if [ "$QS_SETUP_ACTUAL_SHA256" != "$QWREEY_FISH_QS_SETUP_SHA256" ]; then
            echo "user-init: WARNING - qs_setup.fish checksum mismatch (expected $QWREEY_FISH_QS_SETUP_SHA256, got $QS_SETUP_ACTUAL_SHA256) - refusing to source it. Skipping qwreey-fish setup; core services are unaffected. Bump QWREEY_FISH_QS_SETUP_SHA/_SHA256 with ./dev-bump-qwreey-fish.sh, which shows the diff to review." >&2
        elif fish -c "source '$QS_SETUP_TMP' && qs_setup --self qwreey/qwreey-fish@$QWREEY_FISH_QS_SETUP_SHA" < /dev/null; then
            echo "$QWREEY_FISH_QS_SETUP_SHA" > "$QWREEY_FISH_APPLIED_FILE"
        else
            echo "user-init: WARNING - qs_setup reported a failed step (see its output above) - will retry on the next boot. Core services are unaffected." >&2
        fi
    else
        echo "user-init: WARNING - failed to download qs_setup.fish from qwreey-fish@${QWREEY_FISH_QS_SETUP_SHA:0:12} (network issue?) - will retry on the next boot. Core services are unaffected." >&2
    fi
    rm -f "$QS_SETUP_TMP"
fi

# Point git at this image's hook directory (see config/git/hooks/). Written
# to /code/.gitconfig, which lives on the /code volume, so it survives a
# rebuild - but re-checked every boot because a fresh volume has no gitconfig
# at all. The hooks themselves are inert until codedocker.aitrailer.enabled is
# turned on (webmanager's Git Config tab writes it).
#
# Never clobber a value the user chose: core.hooksPath is a single global
# slot, and silently taking it over would kill whatever they pointed it at.
#
# Not a migration, so a failure here only warns: a hand-edited .gitconfig
# with a typo makes every `git config` exit 128, and under `set -e` that
# would crash-loop the whole container over an optional hook.
HOOKS_PATH="/etc/code-docker/git/hooks"
GITCONFIG_RC=0
CURRENT_HOOKS_PATH="$(git config --global --get core.hooksPath 2>/dev/null)" || GITCONFIG_RC=$?
if [ "$GITCONFIG_RC" -gt 1 ]; then
    echo "user-init: WARNING - git can't read the global gitconfig (exit $GITCONFIG_RC; run 'git config --global --list' to see why) - core.hooksPath not checked. Core services are unaffected." >&2
elif [ -z "$CURRENT_HOOKS_PATH" ]; then
    if git config --global core.hooksPath "$HOOKS_PATH"; then
        echo "user-init: set git core.hooksPath to $HOOKS_PATH"
    else
        echo "user-init: WARNING - could not set git core.hooksPath to $HOOKS_PATH (see the error above). Core services are unaffected." >&2
    fi
elif [ "$CURRENT_HOOKS_PATH" != "$HOOKS_PATH" ]; then
    echo "user-init: git core.hooksPath is already set to '$CURRENT_HOOKS_PATH' - leaving it alone." >&2
    echo "user-init: the AI commit-trailer hook will NOT run. To use it, chain to $HOOKS_PATH/hook-dispatch from there, or unset core.hooksPath and reboot." >&2
fi

# No xdg-user-dirs (or equivalent) runs in this container - there's no DE/
# browser to populate Desktop/Documents/Downloads for, so those aren't worth
# creating. Projects is different: webmanager's Projects tab defaults to
# scanning $HOME/Projects (WEBMANAGER_PROJECTS_PATH) but silently shows
# nothing if it's missing, with no prompt telling a new user to create it -
# ensure it exists instead. Unconditional/idempotent, not version-gated.
mkdir -p /code/Projects
