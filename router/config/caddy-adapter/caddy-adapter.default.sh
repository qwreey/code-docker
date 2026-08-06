#!/bin/bash
set -e

# Internal Caddy instance for exposing dev servers (npm run dev etc) - see
# docs/dev-proxy.md. Moved here from code-docker's config/caddy-adapter.default.sh
# (see .claude/backlog/functional-router-plan.md's "Dev Proxy Caddy도 router로
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
# The site address is just ":<port>" - no host restriction at this level.
# Each managed/*.caddy fragment carries its own full "host" matcher
# (internal/devproxy.Expose.Host), so different exposes are free to answer
# for entirely unrelated domains - whatever the outer reverse proxy actually
# forwards here is what decides what's reachable, same trust model as
# everything else in this container.
cat > "$ADAPTER_DIR/Caddyfile" <<EOF
{
	auto_https off
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
