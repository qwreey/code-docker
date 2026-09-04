#!/bin/bash
# Runs AFTER the editor, which is the only way to catch a trailer that was
# typed or pasted into the editor itself - notably `git rebase -i`'s reword,
# where prepare-commit-msg fires on the *old* message and the editor replaces
# it wholesale afterwards (measured, git 2.55).
#
# Both hooks run the same script. That is safe because the rewrite is
# idempotent: its output address is not @anthropic.com, so the second pass
# matches nothing.
exec /etc/code-docker/git/hooks/ai-trailer.sh "$1"
