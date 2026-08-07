#!/bin/bash
set -e

# router's own forward-auth for individual Dev Proxy exposes that opt into
# RequireAuth (see router/backend/internal/devproxy's TinyauthTarget and
# docs/dev-proxy.md#인증). Runs the official tinyauth binary directly
# (extracted from ghcr.io/tinyauthapp/tinyauth in router/Dockerfile) as a
# plain router supervisord program instead of its own compose service -
# tinyauth's own Dockerfile requires a mandatory pnpm frontend build ahead
# of its Go build, which doesn't fit the dind-authz from-source pattern,
# but the prebuilt binary itself needs no such step and drops in here just
# fine.
#
# tinyauth itself refuses to start (exits immediately) without
# TINYAUTH_APPURL set to a real URL - sleep instead of crash-looping when
# it's unset, same opt-out idiom as CADDY_ADAPTER_ENABLED/TAILSCALE_ENABLED.
if [ -z "${TINYAUTH_APPURL:-}" ]; then
    echo "tinyauth: TINYAUTH_APPURL not set - see example-env's TINYAUTH_APPURL comment"
    exec sleep infinity
fi

# tinyauth hardcodes its persistent state (sqlite db, sessions, ...) under
# /data (the upstream image declares it as a VOLUME) - point that at
# router's own persistent volume instead of the image's ephemeral layer,
# same reasoning as tailscale's state under
# /var/lib/code-docker-router/tailscale/state.
mkdir -p /var/lib/code-docker-router/tinyauth
[ -e /data ] || ln -s /var/lib/code-docker-router/tinyauth /data

# router-manager's own per-user credential CRUD (see
# internal/tinyauthusers) writes TINYAUTH_AUTH_USERS to this file whenever a
# user is added/removed, then restarts this program - only sourced when the
# real env var isn't already pinning the value, same priority as
# ROUTER_MANAGER_AUTH_PASSWORD_HASH vs its own file-backed store.
if [ -z "${TINYAUTH_AUTH_USERS:-}" ] && [ -e /var/lib/code-docker-router/tinyauth-users/env ]; then
    . /var/lib/code-docker-router/tinyauth-users/env
    export TINYAUTH_AUTH_USERS
fi

exec /usr/local/bin/tinyauth
