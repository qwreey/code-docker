#!/bin/sh
set -eu

# See tailscale.md at the repo root ("방법 2") for why forwards/publish must
# bind to these dedicated network IPs instead of loopback - binding to
# loopback would get swept up by tailscaled's automatic same-port fallback
# and re-exposed to the whole tailnet regardless of tailnet ACLs.

CONFIG=/code/.local/share/code-docker/tailscale/config.yaml
mkdir -p /code/.local/share/code-docker/tailscale
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
# their own. `tailscale serve` state lives in tailscaled itself, so it's left
# untouched here; it's only reset+reapplied on start (see below).
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

# Both the SOCKS5 proxy and `tailscale serve` need a logged-in session.
until tailscale status --json 2>/dev/null | yq -e '.BackendState == "Running"' >/dev/null 2>&1; do
    sleep 1
done

# code-docker's own IPs on the two dedicated networks (see docker-compose.yml
# aliases). forwards/publish are kept on separate networks so their local
# ports can't collide with each other.
FORWARD_IP=$(getent hosts forward | awk '{ print $1; exit }')
PRIVATE_IP=$(getent hosts private | awk '{ print $1; exit }')

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

# publish: `tailscale serve` rules are declarative state kept by tailscaled,
# so reset then reapply from the YAML on every start - this makes entries
# removed from the YAML actually get torn down.
tailscale serve reset
pcount=$(yq '.publish | length' "$CONFIG")
j=0
while [ "$j" -lt "$pcount" ]; do
    tport=$(yq ".publish[$j].tailscale_port" "$CONFIG")
    lport=$(yq ".publish[$j].local_port" "$CONFIG")
    mode=$(yq ".publish[$j].mode // \"tcp\"" "$CONFIG")
    tailscale serve --bg --"$mode"="$tport" "tcp://$PRIVATE_IP:$lport"
    j=$((j + 1))
done

wait
