#!/bin/bash
# Rewrites the AI co-author trailer an agent harness appends to a commit
# message into an identity of the user's own choosing, and (optionally) drops
# the session-URL trailer.
#
# Invoked from both prepare-commit-msg.default.sh and commit-msg.default.sh
# (see those for why both), which hook-dispatch reaches through the directory
# this image points core.hooksPath at. Between them they cover every commit
# path there is - `-m`, `-F`, the editor, `--amend`, `--no-verify`, and the
# re-commits done by rebase/cherry-pick/revert - because git hands all of them
# the message file as $1. That coverage is the whole reason this is a hook
# rather than a `git` wrapper on PATH parsing argv.
#
# Configuration lives in git config itself, so this keeps working with
# webmanager stopped:
#
#   codedocker.aitrailer.enabled      = true|false   (default false)
#   codedocker.aitrailer.name         = qwreey-bot   (falls back to user.name)
#   codedocker.aitrailer.email        = bot@e.xyz    (falls back to user.email)
#   codedocker.aitrailer.keepModel    = true|false   (default true)
#   codedocker.aitrailer.stripSession = true|false   (default true)
#
# Default-off on purpose: with it on and no name/email configured, the
# fallback would rewrite the co-author into the commit's own author, which is
# meaningless. Nothing happens to anyone's commits until they turn it on.
set -e

MSG_FILE="$1"
[ -n "$MSG_FILE" ] || exit 0
[ -f "$MSG_FILE" ] || exit 0

cfg() { git config --get "$1" 2>/dev/null || true; }

[ "$(cfg codedocker.aitrailer.enabled)" = "true" ] || exit 0

NEW_NAME="$(cfg codedocker.aitrailer.name)"
NEW_EMAIL="$(cfg codedocker.aitrailer.email)"
[ -n "$NEW_NAME" ] || NEW_NAME="$(cfg user.name)"
[ -n "$NEW_EMAIL" ] || NEW_EMAIL="$(cfg user.email)"

# Both halves or neither - a half-filled trailer is a malformed one. With no
# identity to rewrite to we still run, because stripSession may be on.
if [ -z "$NEW_NAME" ] || [ -z "$NEW_EMAIL" ]; then
    NEW_NAME=""
    NEW_EMAIL=""
fi

KEEP_MODEL=1
[ "$(cfg codedocker.aitrailer.keepModel)" = "false" ] && KEEP_MODEL=0

STRIP_SESSION=1
[ "$(cfg codedocker.aitrailer.stripSession)" = "false" ] && STRIP_SESSION=0

[ -n "$NEW_NAME" ] || [ "$STRIP_SESSION" = 1 ] || exit 0

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

awk -v new_name="$NEW_NAME" -v new_email="$NEW_EMAIL" \
    -v keep_model="$KEEP_MODEL" -v strip_session="$STRIP_SESSION" '
# Everything below the scissors line is the `commit -v` diff, not the
# message - a diff can legitimately contain a line that looks like a
# trailer, so stop rewriting once we reach it.
past { print; next }
/^# -+ >8 -+$/ { past = 1; print; next }
/^#/ { print; next }

strip_session == 1 && /^[Cc]laude-[Ss]ession:[ \t]/ { next }

# Match on the EMAIL DOMAIN, not the display name: the name carries the model
# ("Claude Opus 5", "Claude Sonnet 4.5", ...) and keeps changing, the domain
# does not.
/^[Cc]o-[Aa]uthored-[Bb]y:[ \t]*.*<[^>]*@anthropic\.com>[ \t]*$/ {
    if (new_name == "") { print; next }

    model = ""
    if (keep_model == 1) {
        orig = $0
        sub(/^[^:]*:[ \t]*/, "", orig)
        sub(/[ \t]*<[^>]*>[ \t]*$/, "", orig)
        # "Claude Opus 5" -> "Opus 5"; a bare "Claude" leaves nothing, in
        # which case no parenthetical is added at all.
        sub(/^[Cc]laude[ \t]+/, "", orig)
        model = orig
    }

    out = "Co-Authored-By: " new_name
    if (model != "") out = out " (" model ")"
    out = out " <" new_email ">"

    # Two harness trailers collapsing onto one identity must not produce a
    # duplicate trailer.
    if (!(out in seen)) { seen[out] = 1; print out }
    next
}

# Already-rewritten messages fall through here (the new address is not
# @anthropic.com), which is what makes --amend and rebase reword idempotent.
{ print }
' "$MSG_FILE" > "$TMP"

# Write through rather than rename, to keep the file git handed us.
cat "$TMP" > "$MSG_FILE"
