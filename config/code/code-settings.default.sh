#!/bin/bash
set -e

# Seed code-server's user settings.json - but ONLY when it doesn't exist yet.
#
# Deliberately NOT the hash-manifest scheme code-patch.default.sh uses. That
# one works because its targets are files code-docker owns end to end: if the
# user didn't touch it, refreshing it in place is safe. settings.json is the
# opposite - it belongs to the user and to VS Code, which rewrites it every
# time a setting is toggled in the UI. It's also JSONC (comments, trailing
# commas), so there is no safe way to merge a single key into an existing one
# from a shell script without risking corrupting the whole file. So: create it
# if absent, never touch it otherwise.
#
# The cost of that choice is that an already-running deployment doesn't pick up
# a newly added default. Rather than skipping silently (which makes "working"
# and "broken" look identical), we say so on stdout and name the key, so it
# shows up in `docker compose logs` with an actionable line.
#
# Runs from code-service.default.sh, after install.sh (so the user-data dir's
# parent exists) and before code-server itself starts.

SOURCE_DEFAULT=/etc/code-docker/code/settings.default.json
SOURCE_OVERRIDE=/etc/code-docker/code/settings.override.json
TARGET_DIR=/code/.local/share/code-docker/code/user-data/User
TARGET="$TARGET_DIR/settings.json"

if [ -e "$SOURCE_OVERRIDE" ]; then
    source_file="$SOURCE_OVERRIDE"
else
    source_file="$SOURCE_DEFAULT"
fi

if [ ! -e "$source_file" ]; then
    echo "code-settings: no $source_file - nothing to seed"
    exit 0
fi

mkdir -p "$TARGET_DIR"

if [ ! -e "$TARGET" ]; then
    cp "$source_file" "$TARGET"
    echo "code-settings: seeded $TARGET from $(basename -- "$source_file")"
    exit 0
fi

# Already exists - leave it alone, but don't go quiet about defaults that
# therefore never reached this deployment. Only the key name is matched (not
# its value): someone who deliberately set it to true should not be nagged.
missing=""
while read -r key; do
    [ -n "$key" ] || continue
    grep -q "\"$key\"" "$TARGET" || missing="$missing $key"
done <<< "$(grep -oP '(?<=^  ")[^"]+(?=":)' "$source_file")"

if [ -n "$missing" ]; then
    echo "code-settings: $TARGET already exists, left untouched."
    echo "code-settings: these bundled defaults are therefore NOT applied here:$missing"
    echo "code-settings: set them yourself in code-server (Ctrl+, ) if you want them - see docs/build-customization.md"
fi
