#!/bin/bash
set -e

nginx_config=/etc/code-docker/nginx.default.conf
if [ -e /etc/code-docker/nginx.override.conf ]; then
    nginx_config=/etc/code-docker/nginx.override.conf
fi

# NGINX_LOG_LEVEL (docker-compose.yml) selects the access_log suffix that
# nginx.*.conf's ${NGINX_ACCESS_LOG_IF} placeholder gets envsubst'd with:
#   errors (default) - append " if=$loggable" so only 4xx/5xx responses are
#     logged (see the map block in nginx.*.conf).
#   all - append nothing, logging every request like before this toggle
#     existed.
case "${NGINX_LOG_LEVEL:-errors}" in
    all)
        export NGINX_ACCESS_LOG_IF=""
        ;;
    *)
        export NGINX_ACCESS_LOG_IF=" if=\$loggable"
        ;;
esac

# ALLOWED_HOSTS (docker-compose.yml, comma-separated, empty by default)
# becomes nginx.*.conf's `map $host $code_docker_host_allowed { ... }` body.
# Empty means "allow every Host" (current behavior, unchanged) - non-empty
# means "default 0" (deny) plus one `"host" 1;` line per entry.
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

# NGINX_BLOCK_LOOPBACK (docker-compose.yml, default "true") becomes
# nginx.*.conf's `map $server_addr $code_docker_loopback_blocked { ... }`
# body. "true" (default) blocks requests accepted on 127.0.0.1 (tailscale's
# automatic loopback-forward path) - "false" disables the check entirely for
# anyone deliberately proxying into this container via loopback themselves.
case "${NGINX_BLOCK_LOOPBACK:-true}" in
    false)
        export NGINX_LOOPBACK_BLOCK_MAP="default 0;"
        ;;
    *)
        export NGINX_LOOPBACK_BLOCK_MAP="127.0.0.1 1;
    default 0;"
        ;;
esac

# TRUSTED_PROXIES (docker-compose.yml, comma-separated IP/CIDR, empty by
# default) becomes one `set_real_ip_from X;` line per entry - see the
# real_ip_header/real_ip_recursive directives next to the placeholder in
# nginx.*.conf. Empty means no directives at all, so real_ip_header has
# nothing to match and $remote_addr behaves exactly as before this existed.
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

# code-server/webmanager's actual bind targets (code-runner.default.sh,
# webmanager.default.sh) - nginx's proxy_pass has to point at the same
# place, so overriding CODE_SERVER_BIND_ADDR/WEBMANAGER_ADDR moves both the
# service's own bind AND nginx's upstream together instead of only one of
# them (which would just break routing).
export NGINX_CODE_SERVER_UPSTREAM="${CODE_SERVER_BIND_ADDR:-private:8080}"
export NGINX_WEBMANAGER_UPSTREAM="${WEBMANAGER_ADDR:-private:81}"

# nginx config files don't do their own env-var substitution, so the chosen
# conf is rendered through envsubst first (gettext, already pulled in by
# base-devel - see build.default.sh) into a runtime copy. Restricted to just
# these variable names so nginx's own $status/$loggable/$host/etc. in the
# template pass through untouched instead of being blanked out.
generated_config=/run/nginx.generated.conf
envsubst '${NGINX_ACCESS_LOG_IF} ${NGINX_ALLOWED_HOSTS_MAP} ${NGINX_LOOPBACK_BLOCK_MAP} ${NGINX_TRUSTED_PROXIES_DIRECTIVES} ${NGINX_CODE_SERVER_UPSTREAM} ${NGINX_WEBMANAGER_UPSTREAM}' < "$nginx_config" > "$generated_config"

exec nginx -g "daemon off;" -c "$generated_config"
