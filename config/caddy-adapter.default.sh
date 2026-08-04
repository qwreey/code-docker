#!/bin/bash
set -e

# Internal Caddy instance for exposing dev servers (npm run dev etc) via a
# wildcard subdomain - see docs/dev-proxy.md. CADDY_ADAPTER_ENABLED opts out
# entirely (docker-compose.yml), same pattern as TAILSCALE_ENABLED.
if [ "${CADDY_ADAPTER_ENABLED:-true}" = "false" ]; then
    echo "caddy-adapter not enabled by environment"
    exec sleep infinity
fi

ADAPTER_DIR=/code/.caddy-adapter
mkdir -p "$ADAPTER_DIR/managed" "$ADAPTER_DIR/custom"

# The top-level Caddyfile is entirely generated from env vars (the wildcard
# domain/port), never hand-edited - so it's regenerated on every boot
# instead of only-if-missing, same recent convention as
# nginx.default.conf/nginx-service.default.sh for the same reason (an env
# var change should actually take effect on restart). managed/ and custom/
# above are the opposite - webmanager (internal/devproxy) and the user own
# those, so they're only created if missing, never touched again here.
#
# CADDY_ADAPTER_DOMAIN empty means the feature is configured off/not-yet-set
# up: still run Caddy (its admin API is what webmanager's `caddy
# adapt`/`caddy reload` shell-outs target even before any domain is chosen)
# but without a wildcard site block - so nothing is actually exposed yet.
if [ -n "${CADDY_ADAPTER_DOMAIN:-}" ]; then
    site_block="http://${CADDY_ADAPTER_DOMAIN}:${CADDY_ADAPTER_PORT:-8082} {
	import ${ADAPTER_DIR}/managed/*.caddy
	handle {
		respond 404
	}
}"
else
    echo "CADDY_ADAPTER_DOMAIN not set - caddy-adapter running with no wildcard site block yet"
    site_block=""
fi

cat > "$ADAPTER_DIR/Caddyfile" <<EOF
{
	auto_https off
}

${site_block}

import ${ADAPTER_DIR}/custom/*.caddy
EOF

exec caddy run --config "$ADAPTER_DIR/Caddyfile" --adapter caddyfile
