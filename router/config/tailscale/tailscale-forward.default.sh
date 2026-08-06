#!/bin/sh
set -eu

# See docs/tailscale.md at the repo root ("방법 2") for why forwards must
# bind to a dedicated network IP instead of loopback - binding to loopback
# would get swept up by tailscaled's automatic same-port fallback and
# re-exposed to the whole tailnet regardless of tailnet ACLs. Split out of
# the old combined tailscale-forward.default.sh (forwards+publish) per
# functional-router-plan.md's single-responsibility-program principle - see
# tailscale-publish.default.sh for the publish half.

CONFIG=/var/lib/code-docker-router/tailscale/config.yaml
mkdir -p /var/lib/code-docker-router/tailscale
if [ ! -e "$CONFIG" ]; then
    if [ -e /etc/code-docker/tailscale-config.override.yaml ]; then
        cp /etc/code-docker/tailscale-config.override.yaml "$CONFIG"
    else
        cp /etc/code-docker/tailscale-config.default.yaml "$CONFIG"
    fi
fi

pids=""

# Only tears down the socat listeners (parents) so they stop accepting new
# connections - already-accepted (forked) connections are left to finish on
# their own.
cleanup() {
    trap - TERM INT
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in $pids; do
        wait "$pid" 2>/dev/null || true
    done
    exit 0
}
trap cleanup TERM INT

if [ "${TAILSCALE_ENABLED:-true}" = "false" ]; then
    echo "Tailscale not enabled by environment"
    sleep infinity &
    pids="$pids $!"
    wait
    exit 0
fi

until tailscale status --json 2>/dev/null | yq -e '.BackendState == "Running"' >/dev/null 2>&1; do
    sleep 1
done

# router's own IP on the code-docker-forwards network (see
# docker-compose.yml's `forward` alias, moved here from code-docker in this
# migration) - code-docker itself stays attached to that same network
# (unaliased, consumer-only) so `forward:<port>` still resolves to router
# from inside code-docker.
FORWARD_IP=$(getent hosts forward | awk '{ print $1; exit }')

# Keeps this program alive on its own even when forwards: is empty -
# otherwise the plain `wait` at the bottom would return immediately with no
# background jobs, and supervisord would see the program exit right away.
sleep infinity &
pids="$pids $!"

socks5=$(yq '.socks5_address' "$CONFIG")
default_intervall=$(yq '.retry_intervall // 5' "$CONFIG")

# forwards: pull a remote peer's port in via socat + tailscaled's SOCKS5 proxy.
count=$(yq '.forwards | length' "$CONFIG")
i=0
while [ "$i" -lt "$count" ]; do
    local_port=$(yq ".forwards[$i].local_port" "$CONFIG")
    remote_host=$(yq ".forwards[$i].remote_host" "$CONFIG")
    remote_port=$(yq ".forwards[$i].remote_port" "$CONFIG")
    intervall=$(yq ".forwards[$i].retry_intervall // $default_intervall" "$CONFIG")
    socat TCP-LISTEN:"$local_port",bind="$FORWARD_IP",fork,reuseaddr \
        SOCKS5:"$socks5":"$remote_host":"$remote_port",forever,intervall="$intervall" &
    pids="$pids $!"
    i=$((i + 1))
done

wait
