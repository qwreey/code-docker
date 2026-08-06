#!/bin/bash
set -e

nginx_config=/etc/code-docker/nginx.default.conf
if [ -e /etc/code-docker/nginx.override.conf ]; then
    nginx_config=/etc/code-docker/nginx.override.conf
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

# ROUTER_NGINX_DENY_INTERNAL_EXPORTS (default "true") - denies
# code-docker-internal source addresses from reaching /exports/ directly,
# using the subnet docker-compose.yml pins for that network
# (CODE_DOCKER_INTERNAL_SUBNET, set from the network's own ipam.config -
# see docker-compose.yml). "false" disables the check entirely (empty
# directive = nginx's own default, allow all).
case "${ROUTER_NGINX_DENY_INTERNAL_EXPORTS:-true}" in
    false)
        export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE=""
        ;;
    *)
        if [ -n "${CODE_DOCKER_INTERNAL_SUBNET:-}" ]; then
            export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE="deny ${CODE_DOCKER_INTERNAL_SUBNET};
            allow all;"
        else
            echo "nginx-service: ROUTER_NGINX_DENY_INTERNAL_EXPORTS is on but CODE_DOCKER_INTERNAL_SUBNET is unset - skipping the deny (nothing to match against)" >&2
            export NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE=""
        fi
        ;;
esac

# code-docker's whole nginx (port 80) - everything not matched by /exports/
# or /router/ above falls through here unchanged.
export NGINX_CODE_DOCKER_UPSTREAM="code-docker:80"

generated_config=/run/nginx.generated.conf
envsubst '${NGINX_ACCESS_LOG_IF} ${NGINX_ALLOWED_HOSTS_MAP} ${NGINX_ALLOWED_EXPORT_HOSTS_MAP} ${NGINX_LOOPBACK_BLOCK_MAP} ${NGINX_TRUSTED_PROXIES_DIRECTIVES} ${NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE} ${NGINX_CODE_DOCKER_UPSTREAM}' < "$nginx_config" > "$generated_config"

exec nginx -g "daemon off;" -c "$generated_config"
