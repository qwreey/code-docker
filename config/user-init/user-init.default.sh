#!/bin/bash
set -e

export HOME="/code"

CURR_VERSION=1
UMBRELLA="/code/.local/share/code-docker"
VERSION_FILE="$UMBRELLA/migration-version"
LEGACY_VERSION_FILE="/code/.installed"

# qwreey-fish's qs_setup.fish, pinned (security-review H4 fix, 2026-09-14) -
# this used to be `curl <floating main branch> | source`, run as root before
# supervisord starts, once per fresh /code volume, with no checksum at all.
# It's the same repo/owner as this one so the trust tier doesn't change, but
# a single compromised GitHub account/token would otherwise turn into a
# root RCE on every freshly-provisioned volume from that moment on. Bump
# BOTH values together, only after actually reviewing the diff at the new
# SHA - don't just copy the latest `main` blindly:
#   git ls-remote https://github.com/qwreey/qwreey-fish.git main   # -> new SHA
#   curl -sL "https://raw.githubusercontent.com/qwreey/qwreey-fish/<new SHA>/functions/qs_setup.fish" | sha256sum   # -> new hash
# Note qs_setup.fish itself, once running, goes on to `curl | source`
# jorgebucaran/fisher's own installer and `fisher install` a handful of
# floating (unpinned-branch) plugins, and pipes `curl https://mise.run | sh`
# for mise - none of that is pinned by this fix; out of scope here (fisher
# plugin pinning would be a qwreey-fish-side change, not code-docker's).
QWREEY_FISH_QS_SETUP_SHA="706b314b009a8a547fbc40213d30bc73cb6a8a5b"
QWREEY_FISH_QS_SETUP_SHA256="f5e733ebd7ed4d8b9b1f093eb3daf712facee0f307ab47d81af185fda4a4d6ec"

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
    QS_SETUP_URL="https://raw.githubusercontent.com/qwreey/qwreey-fish/${QWREEY_FISH_QS_SETUP_SHA}/functions/qs_setup.fish"
    QS_SETUP_TMP="$(mktemp)"
    # Guarded with if/else, not `|| true` - a download or hash-mismatch
    # here must NOT trip `set -e`, but it also isn't a one-liner
    # ignore-and-continue: we need to branch on whether the hash actually
    # matched before ever sourcing anything. Per this repo's "no silent
    # skips in setup scripts" rule, both failure paths log a clear reason
    # rather than quietly doing nothing - and per "non-essential setup
    # should degrade gracefully", neither path calls `exit`: qwreey-fish is
    # a shell nicety, not a core service, so a bad fetch here must not
    # crash-loop the whole container the way a failed core migration step
    # (see set -e at the top of this file) correctly would.
    if curl -sL "$QS_SETUP_URL" -o "$QS_SETUP_TMP"; then
        QS_SETUP_ACTUAL_SHA256="$(sha256sum "$QS_SETUP_TMP" | awk '{ print $1 }')"
        if [ "$QS_SETUP_ACTUAL_SHA256" = "$QWREEY_FISH_QS_SETUP_SHA256" ]; then
            fish -c "source '$QS_SETUP_TMP' && qs_setup" < /dev/null \
                || echo "user-init: qs_setup exited non-zero (see comment above) - continuing anyway" >&2
        else
            echo "user-init: WARNING - qs_setup.fish checksum mismatch (expected $QWREEY_FISH_QS_SETUP_SHA256, got $QS_SETUP_ACTUAL_SHA256) - refusing to source it. Skipping qwreey-fish shell setup (fish will keep its stock config); this is a non-essential nicety, not a core service, so the container boots normally otherwise. Bump QWREEY_FISH_QS_SETUP_SHA/QWREEY_FISH_QS_SETUP_SHA256 at the top of this script once you've reviewed the new content." >&2
        fi
    else
        echo "user-init: WARNING - failed to download qs_setup.fish from qwreey-fish@${QWREEY_FISH_QS_SETUP_SHA} (network issue?) - skipping qwreey-fish shell setup. This is non-essential; core services are unaffected." >&2
    fi
    rm -f "$QS_SETUP_TMP"
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

# Point git at this image's hook directory (see config/git/hooks/). Written
# to /code/.gitconfig, which lives on the /code volume, so it survives a
# rebuild - but re-checked every boot because a fresh volume has no gitconfig
# at all. The hooks themselves are inert until codedocker.aitrailer.enabled is
# turned on (webmanager's Git Config tab writes it).
#
# Never clobber a value the user chose: core.hooksPath is a single global
# slot, and silently taking it over would kill whatever they pointed it at.
HOOKS_PATH="/etc/code-docker/git/hooks"
CURRENT_HOOKS_PATH="$(git config --global --get core.hooksPath || true)"
if [ -z "$CURRENT_HOOKS_PATH" ]; then
    git config --global core.hooksPath "$HOOKS_PATH"
    echo "user-init: set git core.hooksPath to $HOOKS_PATH"
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
