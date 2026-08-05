#!/bin/bash
set -e

export HOME="/code"

CURR_VERSION=3
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
    fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null
    echo "$CURR_VERSION" > "$VERSION_FILE"
fi
if [ "x$(cat "$VERSION_FILE")x" = "xx" ]; then
    echo "1" > "$VERSION_FILE"
fi

OLD_VERSION="$(cat "$VERSION_FILE")"

# Declared unconditionally (not just inside the v2 block below) so v3 can
# still use them on a container that jumps straight from "already at v2"
# to v3 without ever re-running the v2 block itself.
OLD_PATHS=(/code/.server /code/.tailscale /code/.vector /code/.webmanager /code/.caddy-adapter)
NEW_PATHS=("$UMBRELLA/code" "$UMBRELLA/tailscale" "$UMBRELLA/vector" "$UMBRELLA/webmanager" "$UMBRELLA/caddy-adapter")

# v2: consolidate every code-docker-owned per-service dotdir directly under
# $HOME into $UMBRELLA (see .claude/archive/home-structure-plan.md) - each
# move is skipped if the old path is already gone or the new one already
# exists, so this stays safe to leave in place / re-run on every boot.
if [ "$OLD_VERSION" -lt 2 ]; then
    for i in "${!OLD_PATHS[@]}"; do
        old="${OLD_PATHS[$i]}"
        new="${NEW_PATHS[$i]}"
        if [ -e "$old" ] && [ ! -e "$new" ]; then
            mv "$old" "$new"
        fi
    done
fi

# v3: code-server-autoinstall's install.sh/start.sh bake a few symlinks
# (bin/browser.sh, bin/code, bin/code-server, code-server/lib/vscode/out/vs/
# patch) as absolute paths under $TARGET at creation time - the v2 move
# above leaves any of those created before the move dangling, still
# pointing at the now-gone /code/.server/... prefix. Neither script
# reliably self-heals this on its own (one path's existence check can't
# tell "dangling" from "missing" and never forces an overwrite - confirmed
# via a real `ln: failed to create symbolic link: File exists`; the other
# path only gets recreated on an actual version-triggered reinstall, which
# may not happen for a long time). Re-point each affected symlink from the
# old prefix to the new one in place instead of deleting it - safe/
# idempotent (no-op once nothing points at the old prefix), and doesn't
# leave commands like `code`/`copy` broken in between.
if [ "$OLD_VERSION" -lt 3 ]; then
    for i in "${!OLD_PATHS[@]}"; do
        old="${OLD_PATHS[$i]}"
        new="${NEW_PATHS[$i]}"
        [ -e "$new" ] || continue
        while IFS= read -r link; do
            target="$(readlink "$link")"
            case "$target" in
                "$old"/*)
                    ln -sfn "$new/${target#"$old"/}" "$link"
                    ;;
            esac
        done < <(find "$new" -type l)
    done
fi

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
