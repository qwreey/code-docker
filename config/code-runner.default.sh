#!/bin/bash
set -e

# CODE_SERVER_BIND_ADDR (docker-compose.yml, default "private:8080") is
# appended below as a CLI arg, which code-server's arg parser treats as
# overriding whatever bind-addr ends up in config.yaml (default or
# override) - see code-config.default.yaml's comment for why this can't
# just be a static value in that file. Defaulting to the `private` docker
# network alias (not loopback/0.0.0.0) keeps code-server out of
# tailscaled's automatic same-port forwarding to 127.0.0.1 - see
# docs/tailscale.md.
CODE_SERVER_BIND_ADDR="${CODE_SERVER_BIND_ADDR:-private:8080}"
case "$CODE_SERVER_BIND_ADDR" in
    private:*)
        # Fail loudly on stdout (not stderr - vector only tails
        # stdout.log*, see CLAUDE.md) instead of letting code-server die
        # with a buried DNS error.
        if ! getent hosts private >/dev/null; then
            echo "ERR: cannot resolve 'private' network alias - is code-docker-internal attached with the private alias (see docker-compose.yml)?"
            exit 1
        fi
        ;;
esac

eval $($HOME/.local/bin/mise env --shell bash)
TARGET="/code/.server" exec /etc/code-docker/code-server-autoinstall/start.sh --bind-addr="$CODE_SERVER_BIND_ADDR"
