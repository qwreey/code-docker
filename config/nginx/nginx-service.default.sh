#!/bin/bash
set -e

nginx_config="$(/etc/code-docker/override path nginx/nginx.default.conf)"

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

# The value is pasted into an nginx map, so an entry must be a plain token (no
# quote, `;`, brace or space); anything else is skipped, loudly.
valid_host_token() {
    local host_re='^[][A-Za-z0-9_.*:-]+$'
    [[ "$1" =~ $host_re ]] && return 0
    echo "nginx-service: ALLOWED_HOSTS entry '$1' is not a plain host - skipping it" >&2
    return 1
}

# ALLOWED_HOSTS (comma-separated) becomes the `map $host $code_docker_host_allowed`
# body. Hosts nobody outside can point at an arbitrary address are always
# allowed: localhost, IP literals, single-label names (what internal hops such as
# router -> code-docker send) and tailnet MagicDNS names. Any other name - a real
# domain - must be listed. That is what defeats DNS rebinding: the attack needs
# the browser to send the attacker's own domain as Host, which is never one of
# these. An empty ALLOWED_HOSTS therefore means "local access only", not "any
# Host". The IP-literal patterns must match nothing but an IP literal's exact
# shape (IPv6 always arrives bracketed in Host): any looser, and hex-only
# registrable names such as deadbeef.de pass as "IP literals".
# nginx-allowed-hosts_test.sh pins this.
map_body='default 0;
    "localhost" 1;
    "~^[0-9]{1,3}(\.[0-9]{1,3}){3}$" 1;
    "~^\[[0-9A-Fa-f:.]+\]$" 1;
    "~^[^.]+$" 1;
    "~\.ts\.net$" 1;'
if [ -n "${ALLOWED_HOSTS:-}" ]; then
    IFS=',' read -ra allowed_hosts <<< "$ALLOWED_HOSTS"
    for host in "${allowed_hosts[@]}"; do
        host="$(echo "$host" | xargs)"
        [ -n "$host" ] && valid_host_token "$host" && map_body="$map_body
    \"$host\" 1;"
    done
fi
export NGINX_ALLOWED_HOSTS_MAP="$map_body"

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
export NGINX_CODE_SERVER_UPSTREAM="${CODE_SERVER_BIND_ADDR:-127.0.0.1:8080}"
export NGINX_WEBMANAGER_UPSTREAM="${WEBMANAGER_ADDR:-127.0.0.1:81}"

# NGINX_WEBDAV_PORT (docker-compose.yml, default 82) - the WebDAV-only
# listener nginx.*.conf's second server{} block binds, so a router vhost can
# give the file share its own hostname without publishing code-server on it
# too (see that block's own comment and docs/tips/webdav.md). A non-numeric
# value would make nginx refuse to start at all, taking code-server down
# with it, so it falls back to the default loudly rather than being passed
# through.
webdav_port="${NGINX_WEBDAV_PORT:-82}"
if ! [[ "$webdav_port" =~ ^[0-9]+$ ]] || [ "$webdav_port" -lt 1 ] || [ "$webdav_port" -gt 65535 ]; then
    echo "nginx-service: NGINX_WEBDAV_PORT='$webdav_port' is not a valid port - using 82" >&2
    webdav_port=82
fi
export NGINX_WEBDAV_PORT="$webdav_port"

# Dev Proxy (/exports/) and router-manager's admin API used to be proxied
# through from here too (caddy-adapter/router-manager upstreams) - router
# now terminates host:80 directly and handles both itself, see
# router-docker's .claude/router-nginx-hardening-plan.md. This nginx only ever
# serves code-server/webmanager now.

# NGINX_ALLOWED_PEERS (docker-compose.yml, comma-separated hostnames, IPs or
# CIDRs; empty means ROUTER_HOSTNAME) is who may connect to nginx at all,
# rendered as `allow` lines ahead of a `deny all` in both server blocks.
# Loopback is always allowed. nginx is the one door to code-server (no login)
# and webmanager (no login by default), and code-docker-internal also holds
# sibling projects' containers and, through dind's NAT, every container
# created inside dind - none of which should get a shell here. "any" drops
# the restriction (e.g. a deployment that publishes this port without
# router).
#
# allow takes addresses, not names, so a hostname is resolved here and again
# every few seconds by the loop at the bottom: router gets a new IP when it
# is recreated, and an allow list stuck on the old one would lock everyone
# out until this program restarted.
allowed_peers="${NGINX_ALLOWED_PEERS:-${ROUTER_HOSTNAME:-router}}"
peer_hosts=()
peer_static=""
if [ "$allowed_peers" != any ]; then
    IFS=',' read -ra peer_entries <<< "$allowed_peers"
    for peer in "${peer_entries[@]}"; do
        peer="$(echo "$peer" | xargs)"
        [ -n "$peer" ] || continue
        if [[ "$peer" =~ ^[0-9.]+(/[0-9]+)?$ || "$peer" =~ ^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(/[0-9]+)?$ ]]; then
            peer_static="$peer_static $peer"
        elif [[ "$peer" =~ ^[A-Za-z0-9_.-]+$ ]]; then
            peer_hosts+=("$peer")
        else
            echo "nginx-service: NGINX_ALLOWED_PEERS entry '$peer' is not a hostname, IP or CIDR - skipping it" >&2
        fi
    done
fi

# Prints the current addresses of every hostname in peer_hosts, sorted, one
# per line. A name that doesn't resolve right now is reported and left out.
resolve_peers() {
    local host
    for host in "${peer_hosts[@]}"; do
        getent ahosts "$host" 2>/dev/null | awk '{ print $1 }' | grep . \
            || echo "nginx-service: '$host' (NGINX_ALLOWED_PEERS) does not resolve right now" >&2
    done | sort -u
}

# nginx config files don't do their own env-var substitution, so the chosen
# conf is rendered through envsubst first (gettext, already pulled in by
# base-devel - see build.default.sh) into a runtime copy. Restricted to just
# these variable names so nginx's own $status/$loggable/$host/etc. in the
# template pass through untouched instead of being blanked out.
generated_config=/run/nginx.generated.conf
render_config() {
    local addr
    NGINX_PEER_ACCESS=""
    if [ "$allowed_peers" != any ]; then
        for addr in 127.0.0.1 ::1 $peer_static $1; do
            NGINX_PEER_ACCESS="$NGINX_PEER_ACCESS
        allow $addr;"
        done
        NGINX_PEER_ACCESS="$NGINX_PEER_ACCESS
        deny all;"
    fi
    export NGINX_PEER_ACCESS
    envsubst '${NGINX_ACCESS_LOG_IF} ${NGINX_ALLOWED_HOSTS_MAP} ${NGINX_TRUSTED_PROXIES_DIRECTIVES} ${NGINX_CODE_SERVER_UPSTREAM} ${NGINX_WEBMANAGER_UPSTREAM} ${NGINX_WEBDAV_PORT} ${NGINX_PEER_ACCESS}' < "$nginx_config" > "$generated_config"
}

peer_addrs="$(resolve_peers | xargs)"
render_config "$peer_addrs"
if [ "$allowed_peers" = any ]; then
    echo "nginx-service: NGINX_ALLOWED_PEERS=any - every container that can reach this one may use nginx"
else
    peers_now="$(echo $peer_static $peer_addrs)"
    echo "nginx-service: accepting connections from loopback and ${peers_now:-nothing else yet} (NGINX_ALLOWED_PEERS=$allowed_peers)"
fi

if [ ${#peer_hosts[@]} -eq 0 ]; then
    exec nginx -g "daemon off;" -c "$generated_config"
fi

# Stays alive as the refresh loop, nginx as its child - supervisord's
# stopasgroup/killasgroup (supervisord.d/nginx.conf) stop both.
nginx -g "daemon off;" -c "$generated_config" &
nginx_pid=$!
trap 'kill "$nginx_pid" 2>/dev/null; wait "$nginx_pid" 2>/dev/null; exit 0' TERM INT
while kill -0 "$nginx_pid" 2>/dev/null; do
    sleep 5 & wait $!
    new_addrs="$(resolve_peers 2>/dev/null | xargs)"
    # Empty means the lookup failed (router mid-recreate, say), not that
    # the peer is gone: keep serving the last known addresses.
    if [ -n "$new_addrs" ] && [ "$new_addrs" != "$peer_addrs" ]; then
        echo "nginx-service: NGINX_ALLOWED_PEERS addresses changed ($peer_addrs -> $new_addrs), reloading"
        peer_addrs="$new_addrs"
        render_config "$peer_addrs"
        nginx -s reload -c "$generated_config" || echo "nginx-service: reload failed, still on the previous allow list" >&2
    fi
done
wait "$nginx_pid"
exit $?
