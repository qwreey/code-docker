#!/bin/bash
set -e

# WEBMANAGER_ADDR (read directly by the webmanager binary, config.go's
# own default is "private:81") keeps webmanager off loopback/0.0.0.0 so
# tailscaled's automatic same-port forwarding to 127.0.0.1 never sees it -
# see docs/tailscale.md. Only guard the `private` alias when it's actually
# in play (default, or an explicit override that still points at it) -
# an operator who overrode WEBMANAGER_ADDR to something else entirely is
# responsible for that address working. Fail loudly on stdout (not stderr -
# vector only tails stdout.log*, see CLAUDE.md) instead of letting
# webmanager die with a buried DNS error.
case "${WEBMANAGER_ADDR:-private:81}" in
    private:*)
        if ! getent hosts private >/dev/null; then
            echo "ERR: cannot resolve 'private' network alias - is code-docker-internal attached with the private alias (see docker-compose.yml)?"
            exit 1
        fi
        ;;
esac

export WEBMANAGER_STATIC_DIR=/etc/code-docker/webmanager/static
exec /etc/code-docker/webmanager/webmanager
