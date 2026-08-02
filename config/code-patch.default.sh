#!/bin/bash

# Seed /etc/code-docker/code-patch/*.default.* (each with an optional
# matching *.override.*) into /code/.server/patch/<name>.* - code-server-
# autoinstall injects every top-level patch/*.js as a <script> on the
# workbench page (see README's "코드 서버 패치"). Only copied in if missing
# at the target, so user edits survive across restarts. A manifest tracks
# what we've seeded so a default dropped in a later code-docker version
# gets removed here too instead of lingering forever.
#
# Runs from code-service.default.sh, after install.sh, so /code/.server
# (and its patch/ folder) actually exists by the time this runs.

SOURCE_DIR=/etc/code-docker/code-patch
TARGET_DIR=/code/.server/patch
MANIFEST=/code/.server/.code-patch-manifest
mkdir -p "$TARGET_DIR"

current_names=""
if [ -d "$SOURCE_DIR" ]; then
    for default_file in "$SOURCE_DIR"/*.default.*; do
        [ -e "$default_file" ] || continue
        base="$(basename -- "$default_file")"
        ext="${base##*.}"
        name="${base%.default.*}.$ext"
        current_names="$current_names $name"

        target="$TARGET_DIR/$name"
        if [ ! -e "$target" ]; then
            override_file="$SOURCE_DIR/${base%.default.*}.override.$ext"
            if [ -e "$override_file" ]; then
                cp "$override_file" "$target"
            else
                cp "$default_file" "$target"
            fi
        fi
    done
fi

if [ -e "$MANIFEST" ]; then
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        case " $current_names " in
            *" $name "*) ;;
            *) rm -f "$TARGET_DIR/$name" ;;
        esac
    done < "$MANIFEST"
fi

: > "$MANIFEST"
for name in $current_names; do
    echo "$name" >> "$MANIFEST"
done
