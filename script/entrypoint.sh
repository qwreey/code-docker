#!/bin/bash
set -e

# Init runtime dir
mkdir -p /run/xdg && chmod 700 /run/xdg
export XDG_RUNTIME_DIR=/run/xdg

# Run home-folder migrations before any supervisord program can touch $HOME
# - several programs below start at the same priority and would otherwise
# race user-init creating/moving their state dirs (see
# .claude/backlog/home-structure-plan.md). Not exec'd - this must return so
# supervisord can start next; a failure here trips `set -e` above and kills
# the container instead of continuing in a half-migrated state.
/etc/code-docker/user-init.sh

# Run supervisord
mkdir -p /code/.local
if [ -e /etc/code-docker/supervisord.override.conf ]; then
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.override.conf --user root
else
    exec /sbin/supervisord -n -c /etc/code-docker/supervisord.default.conf --user root
fi
