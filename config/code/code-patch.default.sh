#!/bin/bash
set -e

# Seed /etc/code-docker/code/code-patch/*.default.* (each with an optional
# matching *.override.*) into
# /code/.local/share/code-docker/code/patch/<name>.* - code-server-
# autoinstall injects every top-level patch/*.js as a <script> on the
# workbench page (see README's "코드 서버 패치").
#
# Re-seeded on every boot IF AND ONLY IF the live target's content still
# matches the hash we recorded the last time we seeded it - i.e. the user
# never touched it directly. This matters because a plain "only copy if
# missing" (the old behavior) meant an updated *.default.* file shipped in a
# later code-docker version silently never reached anyone who'd already
# booted once: the target already existed and was never revisited, so a
# real bugfix to a bundled patch script could sit there forever without
# taking effect. If the live file's hash doesn't match what we last seeded
# (or we have no recorded hash for it at all - e.g. it predates this
# hash-tracking, or this is the very first run), we leave it alone rather
# than risk clobbering a user's own edit - delete the file under
# $TARGET_DIR once to force a fresh reseed with hash-tracking from then on
# (this is also why upgrading to this script won't retroactively re-apply a
# fixed default to an already-seeded, never-touched file on its own: there's
# no prior hash on record for it yet, so the first run after upgrading just
# starts tracking from whatever is live).
#
# Runs from code-service.default.sh, after install.sh, so
# /code/.local/share/code-docker/code (and its patch/ folder) actually
# exists by the time this runs.

SOURCE_DIR=/etc/code-docker/code/code-patch
TARGET_DIR=/code/.local/share/code-docker/code/patch
MANIFEST=/code/.local/share/code-docker/code/.code-patch-manifest
mkdir -p "$TARGET_DIR"

# Manifest format: one "<name>\t<hash>" per line (hash = sha1sum of the
# content we last seeded target with). Lines from before this hash-tracking
# existed are just "<name>" with no tab, which reads back with an empty
# hash below - treated the same as "no baseline recorded yet".
declare -A prev_hash
if [ -e "$MANIFEST" ]; then
    while IFS=$'\t' read -r name hash; do
        [ -n "$name" ] || continue
        prev_hash["$name"]="$hash"
    done < "$MANIFEST"
fi

current_names=""
: > "$MANIFEST.tmp"
if [ -d "$SOURCE_DIR" ]; then
    for default_file in "$SOURCE_DIR"/*.default.*; do
        [ -e "$default_file" ] || continue
        base="$(basename -- "$default_file")"
        ext="${base##*.}"
        name="${base%.default.*}.$ext"
        current_names="$current_names $name"

        override_file="$SOURCE_DIR/${base%.default.*}.override.$ext"
        if [ -e "$override_file" ]; then
            source_file="$override_file"
        else
            source_file="$default_file"
        fi
        desired_hash="$(sha1sum "$source_file" | awk '{print $1}')"

        target="$TARGET_DIR/$name"
        if [ ! -e "$target" ]; then
            cp "$source_file" "$target"
            printf '%s\t%s\n' "$name" "$desired_hash" >> "$MANIFEST.tmp"
            continue
        fi

        live_hash="$(sha1sum "$target" | awk '{print $1}')"
        if [ -n "${prev_hash[$name]:-}" ] && [ "$live_hash" = "${prev_hash[$name]}" ]; then
            # Untouched since we last seeded it - safe to refresh in place.
            cp "$source_file" "$target"
            printf '%s\t%s\n' "$name" "$desired_hash" >> "$MANIFEST.tmp"
        else
            # User-modified (or predates hash tracking) - leave it, but keep
            # carrying forward whatever baseline we last knew (possibly
            # still empty) so this stays consistent on future runs.
            printf '%s\t%s\n' "$name" "${prev_hash[$name]:-}" >> "$MANIFEST.tmp"
        fi
    done
fi

mv "$MANIFEST.tmp" "$MANIFEST"

for name in "${!prev_hash[@]}"; do
    case " $current_names " in
        *" $name "*) ;;
        *) rm -f "$TARGET_DIR/$name" ;;
    esac
done
