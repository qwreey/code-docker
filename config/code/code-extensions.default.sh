#!/bin/bash
set -e

# Keep code-docker's built-in webmanager extension
# (webmanager/vscode-extension/) installed at exactly the build baked into
# this image. Runs from code-service.default.sh on every start, after
# install.sh and before code-server itself starts, so no running extension
# host holds the files being replaced.
#
# Compared by the build stamp (a hash of the extension's source, written by
# the Dockerfile's code-extension stage), not by version: a rebuild with
# changed extension code always lands, including a downgrade or a same-
# version rebuild - `docker compose build && up` is all it takes. When
# nothing changed this is a few file reads, no code-server CLI call.
#
# It is a built-in feature, so an uninstall from the Extensions view is
# undone on the next start; CODE_WEBMANAGER_EXTENSION=false is the way to
# turn it off (and removes it). A *disabled* state is left alone - that
# lives in code-server's own storage, which this never touches.

SPATH=/code/.local/share/code-docker/code
CLI="$SPATH/code-server/bin/code-server"
ID=code-docker.webmanager
VSIX=/etc/code-docker/code/extensions/code-docker-webmanager.vsix
IMAGE_STAMP_FILE=/etc/code-docker/code/extensions/code-docker-webmanager.stamp
LOCAL_STAMP_FILE="$SPATH/.code-extension-webmanager.stamp"
EXT_DIR="$SPATH/extensions"
ARGS=(--user-data-dir="$SPATH/user-data" --extensions-dir="$EXT_DIR")

listed() {
    [ -f "$EXT_DIR/extensions.json" ] && grep -q "\"id\":\"$ID\"" "$EXT_DIR/extensions.json"
}

if [ "${CODE_WEBMANAGER_EXTENSION:-true}" = "false" ]; then
    if listed; then
        "$CLI" "${ARGS[@]}" --uninstall-extension "$ID" >/dev/null
        echo "code-extensions: CODE_WEBMANAGER_EXTENSION=false - removed the webmanager extension"
    fi
    rm -f "$LOCAL_STAMP_FILE"
    exit 0
fi

if [ ! -f "$VSIX" ] || [ ! -f "$IMAGE_STAMP_FILE" ]; then
    echo "code-extensions: no bundled webmanager extension in this image - skipping"
    exit 0
fi

read -r VER STAMP < "$IMAGE_STAMP_FILE"

in_sync() {
    [ -f "$LOCAL_STAMP_FILE" ] || return 1
    [ "$(cat "$LOCAL_STAMP_FILE")" = "$VER $STAMP" ] || return 1
    listed || return 1
    grep -q "\"id\":\"$ID\"[^}]*}[^}]*\"version\":\"$VER\"" "$EXT_DIR/extensions.json" || return 1
    compgen -G "$EXT_DIR/$ID-$VER*" >/dev/null || return 1
    # An uninstall only marks the directory obsolete until code-server
    # next cleans up, so the directory alone isn't proof it's installed.
    if [ -f "$EXT_DIR/.obsolete" ] && grep -q "$ID-" "$EXT_DIR/.obsolete"; then
        return 1
    fi
}

if in_sync; then
    exit 0
fi

# Uninstall first: --force alone may treat a same-version rebuild or a
# downgrade as already installed.
"$CLI" "${ARGS[@]}" --uninstall-extension "$ID" >/dev/null 2>&1 || true
"$CLI" "${ARGS[@]}" --install-extension "$VSIX" --force >/dev/null
echo "$VER $STAMP" > "$LOCAL_STAMP_FILE"
echo "code-extensions: synced webmanager extension $VER (build $STAMP)"
