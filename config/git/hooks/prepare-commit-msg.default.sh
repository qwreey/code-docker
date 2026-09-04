#!/bin/bash
# Runs BEFORE the editor opens, so the rewrite is what the user actually sees
# in their editor - and it is the only one of the two that still runs under
# `git commit --no-verify`. See ai-trailer.sh, and commit-msg.default.sh for
# the other half.
exec /etc/code-docker/git/hooks/ai-trailer.sh "$1"
