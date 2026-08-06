#!/bin/bash
set -e

# Internal Caddy instance for exposing dev servers (npm run dev etc) - see
# docs/dev-proxy.md. Moved here from code-docker's config/caddy-adapter.default.sh
# (see .claude/functional-router-plan.md's "Dev Proxy Caddy도 router로
# 이관") - state now lives on router's own volume instead of /code.
# CADDY_ADAPTER_ENABLED opts out entirely, same pattern as TAILSCALE_ENABLED.
if [ "${CADDY_ADAPTER_ENABLED:-true}" = "false" ]; then
    echo "caddy-adapter not enabled by environment"
    exec sleep infinity
fi

ADAPTER_DIR=/var/lib/code-docker-router/caddy-adapter
mkdir -p "$ADAPTER_DIR/managed" "$ADAPTER_DIR/custom"

# The top-level Caddyfile is entirely generated from env vars (just the
# port - see below), never hand-edited - so it's regenerated on every boot
# instead of only-if-missing, same convention as nginx.default.conf/
# nginx-service.default.sh for the same reason (an env var change should
# actually take effect on restart). managed/ and custom/ above are the
# opposite - router-manager (internal/devproxy) and the user own those, so
# they're only created if missing, never touched again here.
#
# admin unix//run/caddy-admin.sock: Caddy's own admin API (config reload,
# used by internal/devproxy's Reload) moved off its stock TCP default
# (localhost:2019) onto a unix socket that no route's `target` field can
# ever address - ValidateTarget's charset doesn't allow "/", so this closes
# the self-SSRF path a route with target=localhost:2019 used to have (see
# router/.claude/router-nginx-hardening-plan.md, Finding 1). /run is
# container-local tmpfs, same reasoning as router-manager's own socket.
#
# Two separate site blocks for the unix socket router's own nginx proxies
# to (default path) and the existing CADDY_ADAPTER_PORT TCP listener
# (docs/dev-proxy.md's direct-publish alternative, unchanged). Verified
# live (v2.11.4) that a unix path can't be used directly as a site
# address's header - Caddy's site-address parser doesn't recognize
# "unix//path" the way the global `admin` directive does, and instead
# misparses it as host="unix" + path="/path" on an implicit :443 listener
# (logged as a "deprecated path in site address" warning). The working
# pattern, confirmed by curling both listeners with an arbitrary Host: a
# plain port-number placeholder as the site header (never actually bound -
# irrelevant once overridden) plus `bind unix/<path>` inside the block,
# which correctly replaces the listen address with the socket and imposes
# no host/path matcher.
#
# No host restriction at either address - each managed/*.caddy fragment
# carries its own full "host" matcher (internal/devproxy.Expose.Host), so
# different exposes are free to answer for entirely unrelated domains -
# whatever reaches here is what decides what's reachable, same trust model
# as everything else in this container.
cat > "$ADAPTER_DIR/Caddyfile" <<EOF
{
	auto_https off
	admin unix//run/caddy-admin.sock
}

:9999 {
	bind unix//run/caddy-adapter.sock
	import ${ADAPTER_DIR}/managed/*.caddy
	handle {
		respond 404
	}
}

http://:${CADDY_ADAPTER_PORT:-8082} {
	import ${ADAPTER_DIR}/managed/*.caddy
	handle {
		respond 404
	}
}

import ${ADAPTER_DIR}/custom/*.caddy
EOF

exec caddy run --config "$ADAPTER_DIR/Caddyfile" --adapter caddyfile
