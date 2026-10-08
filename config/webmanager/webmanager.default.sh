#!/bin/bash
set -e

# WEBMANAGER_ADDR is read directly by the webmanager binary (config.go's
# default is "127.0.0.1:81"): loopback, because nginx in this same container
# is the only thing meant to reach it - see code-runner.default.sh for the
# same reasoning about code-server.
case "${WEBMANAGER_ADDR:-}" in
    private:*)
        # Fail loudly: the `private` network alias this used to default to is gone.
        echo "ERR: WEBMANAGER_ADDR=$WEBMANAGER_ADDR - the 'private' alias no longer exists; use 127.0.0.1:${WEBMANAGER_ADDR#private:} (or unset it)"
        exit 1
        ;;
esac

export WEBMANAGER_STATIC_DIR=/etc/code-docker/webmanager/static
exec /etc/code-docker/webmanager/webmanager
