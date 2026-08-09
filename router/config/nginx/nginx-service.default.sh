#!/bin/bash
set -e

nginx_config=/etc/router/nginx.default.conf
if [ -e /etc/router/nginx.override.conf ]; then
    nginx_config=/etc/router/nginx.override.conf
fi

# Same NGINX_LOG_LEVEL/ALLOWED_HOSTS/NGINX_BLOCK_LOOPBACK/TRUSTED_PROXIES
# handling as the main image's config/nginx-service.default.sh - these env
# vars are now shared across both code-docker's and router's environment:
# blocks (docker-compose.yml), since router is the actual internet-facing
# hop now and benefits from the same checks at its own layer too.
case "${NGINX_LOG_LEVEL:-errors}" in
    all)
        export NGINX_ACCESS_LOG_IF=""
        ;;
    *)
        export NGINX_ACCESS_LOG_IF=" if=\$loggable"
        ;;
esac

if [ -n "${ALLOWED_HOSTS:-}" ]; then
    map_body="default 0;"
    IFS=',' read -ra allowed_hosts <<< "$ALLOWED_HOSTS"
    for host in "${allowed_hosts[@]}"; do
        host="$(echo "$host" | xargs)"
        [ -n "$host" ] && map_body="$map_body
    \"$host\" 1;"
    done
else
    map_body="default 1;"
fi
export NGINX_ALLOWED_HOSTS_MAP="$map_body"

# ALLOWED_EXPORT_HOSTS moved here from code-docker's own nginx along with
# the /exports/ location itself (see router/.claude/router-nginx-hardening-plan.md).
if [ -n "${ALLOWED_EXPORT_HOSTS:-}" ]; then
    export_map_body="default 0;"
    IFS=',' read -ra allowed_export_hosts <<< "$ALLOWED_EXPORT_HOSTS"
    for host in "${allowed_export_hosts[@]}"; do
        host="$(echo "$host" | xargs)"
        [ -n "$host" ] && export_map_body="$export_map_body
    \"$host\" 1;"
    done
else
    export_map_body="default 1;"
fi
export NGINX_ALLOWED_EXPORT_HOSTS_MAP="$export_map_body"

case "${NGINX_BLOCK_LOOPBACK:-true}" in
    false)
        export NGINX_LOOPBACK_BLOCK_MAP="default 0;"
        ;;
    *)
        export NGINX_LOOPBACK_BLOCK_MAP="127.0.0.1 1;
    default 0;"
        ;;
esac

directives=""
if [ -n "${TRUSTED_PROXIES:-}" ]; then
    IFS=',' read -ra trusted_proxies <<< "$TRUSTED_PROXIES"
    for proxy in "${trusted_proxies[@]}"; do
        proxy="$(echo "$proxy" | xargs)"
        [ -n "$proxy" ] && directives="$directives
    set_real_ip_from $proxy;"
    done
fi
export NGINX_TRUSTED_PROXIES_DIRECTIVES="$directives"

# detect_internal_subnet - code-docker-internal has no pinned subnet in
# docker-compose.yml (Docker auto-assigns it, so multiple PREFIX instances
# on one host never fight over the same hardcoded CIDR). router sits on
# both code-docker-internal and code-docker-external, so it can find
# code-docker-internal's live CIDR itself: the interface NOT carrying the
# default route is always code-docker-external (the only network with a
# real gateway - code-docker-internal is `internal: true`), so the *other*
# connected/kernel-scope route belongs to code-docker-internal. This is the
# same "no default route = internal-side interface" heuristic
# dind-entrypoint.sh already uses to find its own IP. Only reliable while
# router has exactly these two networks - if a third one is ever added,
# fall back to setting ROUTER_INTERNAL_SUBNET explicitly.
detect_internal_subnet() {
    default_dev="$(ip -4 route show default 2>/dev/null \
        | awk '{for (i=1;i<=NF;i++) if ($i=="dev") { print $(i+1); exit }}')"
    [ -n "$default_dev" ] || return 1
    ip -4 route show scope link 2>/dev/null \
        | awk -v skip="$default_dev" '
            {
                dev=""
                for (i=1;i<=NF;i++) if ($i=="dev") dev=$(i+1)
                if (dev != "" && dev != skip) { print $1; exit }
            }'
}

# ROUTER_NGINX_DENY_INTERNAL_EXPORTS (default "true") - denies
# code-docker-internal source addresses from reaching /exports/ directly,
# using ROUTER_INTERNAL_SUBNET if set, else the CIDR detect_internal_subnet
# finds live above. "false" disables the check entirely (empty directive =
# nginx's own default, allow all) - the escape hatch for a topology where a
# trusted proxy (e.g. a user's own Caddy) legitimately reaches router *from
# inside* code-docker-internal instead of from outside.
case "${ROUTER_NGINX_DENY_INTERNAL_EXPORTS:-true}" in
    false)
        export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE=""
        ;;
    *)
        internal_subnet="${ROUTER_INTERNAL_SUBNET:-}"
        if [ -z "$internal_subnet" ]; then
            internal_subnet="$(detect_internal_subnet || true)"
        fi
        if [ -n "$internal_subnet" ]; then
            export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE="deny ${internal_subnet};
            allow all;"
        else
            echo "nginx-service: ROUTER_NGINX_DENY_INTERNAL_EXPORTS is on but couldn't determine code-docker-internal's subnet (ROUTER_INTERNAL_SUBNET unset and auto-detection failed) - skipping the deny" >&2
            export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE=""
        fi
        ;;
esac

# ROUTER_MANAGER_HOSTS (router/example-env.router, comma-separated, default
# empty) - builds an entire extra server{} block (see
# router/config/nginx/nginx.default.conf's own comment on this placeholder)
# giving router-manager a dedicated origin, separate from the shared
# /router/ path. Empty means the placeholder substitutes to nothing and the
# main config is unchanged from before this feature existed - deliberately
# off by default, same as every other opt-in feature in this repo.
if [ -n "${ROUTER_MANAGER_HOSTS:-}" ]; then
    IFS=',' read -ra router_manager_hosts <<< "$ROUTER_MANAGER_HOSTS"
    server_names=""
    for host in "${router_manager_hosts[@]}"; do
        host="$(echo "$host" | xargs)"
        [ -n "$host" ] && server_names="$server_names $host"
    done
    if [ -n "$server_names" ]; then
        export NGINX_ROUTER_MANAGER_SERVER_BLOCK="server {
        listen 80;
        server_name$server_names;

        if (\$code_docker_loopback_blocked) {
            return 403 \"blocked: reached via tailscale's automatic loopback forwarding, not the published port - see NGINX_BLOCK_LOOPBACK in example-env\n\";
        }

        # router/frontend's own api/client.ts hardcodes every API call under
        # /router/api/... regardless of which origin the SPA is actually
        # served from (see router/frontend/src/api/client.ts) - so this
        # dedicated domain needs the exact same /router/ prefix-strip
        # location as the shared hostname's own copy
        # (router/config/nginx/nginx.default.conf), even though the SPA
        # itself is served from this domain's root below, not /router/.
        location /router/ {
            proxy_pass http://unix:/run/router-manager.sock:/;
            proxy_set_header Host \$host;
        }

        # The SPA itself (and its relative-pathed JS/CSS - see
        # router/frontend/vite.config.ts's base setting) at this domain's
        # root, so router-manager is reachable as a real standalone site
        # without needing the /router/ segment at all.
        location / {
            proxy_pass http://unix:/run/router-manager.sock:/;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \"upgrade\";
            proxy_set_header Host \$host;
        }
    }"
    else
        export NGINX_ROUTER_MANAGER_SERVER_BLOCK=""
    fi
else
    export NGINX_ROUTER_MANAGER_SERVER_BLOCK=""
fi

generated_config=/run/nginx.generated.conf
envsubst '${NGINX_ACCESS_LOG_IF} ${NGINX_ALLOWED_HOSTS_MAP} ${NGINX_ALLOWED_EXPORT_HOSTS_MAP} ${NGINX_LOOPBACK_BLOCK_MAP} ${NGINX_TRUSTED_PROXIES_DIRECTIVES} ${NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE} ${NGINX_ROUTER_MANAGER_SERVER_BLOCK}' < "$nginx_config" > "$generated_config"

exec nginx -g "daemon off;" -c "$generated_config"
