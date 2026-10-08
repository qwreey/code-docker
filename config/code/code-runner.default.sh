#!/bin/bash
set -e

# CODE_SERVER_BIND_ADDR (docker-compose.yml, default "127.0.0.1:8080") is
# appended below as a CLI arg, which code-server's arg parser treats as
# overriding whatever bind-addr ends up in config.yaml (default or
# override) - see code-config.default.yaml's comment for why this can't
# just be a static value in that file. Loopback because nginx, in this same
# container, is the only thing meant to reach it: code-server has no login
# (auth: none), and nginx is where who may connect is decided
# (NGINX_ALLOWED_PEERS, see nginx-service.default.sh) - an address on
# code-docker-internal would let every container on that network around it.
CODE_SERVER_BIND_ADDR="${CODE_SERVER_BIND_ADDR:-127.0.0.1:8080}"
case "$CODE_SERVER_BIND_ADDR" in
    private:*)
        # Fail loudly: the `private` network alias this used to default to is gone.
        echo "ERR: CODE_SERVER_BIND_ADDR=$CODE_SERVER_BIND_ADDR - the 'private' alias no longer exists; use 127.0.0.1:${CODE_SERVER_BIND_ADDR#private:} (or unset it)"
        exit 1
        ;;
esac

# mise itself is installed by qs_setup during user-init.sh's first-time
# fish shell setup - if that setup failed partway (see
# config/user-init.default.sh's comment on qs_setup's non-fatal exit
# status), mise may not be here yet. That's not fatal to code-server
# itself, just to mise-managed tools being on PATH for it - warn and skip
# rather than failing the whole service.
if [ -x "$HOME/.local/bin/mise" ]; then
    eval "$("$HOME/.local/bin/mise" env --shell bash)"
else
    echo "WARN: $HOME/.local/bin/mise not found - skipping mise env setup (mise-installed tools won't be on PATH for code-server)"
fi
TARGET="/code/.local/share/code-docker/code" exec /etc/code-docker/code-server-autoinstall/start.sh --bind-addr="$CODE_SERVER_BIND_ADDR"
