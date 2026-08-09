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
    if [ -e /etc/router/tailscale-config.override.yaml ]; then
        cp /etc/router/tailscale-config.override.yaml "$CONFIG"
    else
        cp /etc/router/tailscale-config.default.yaml "$CONFIG"
    fi
fi

pids=""

# Only tears down the socat listeners (parents) so they stop accepting new
# connections - already-accepted (forked) connections are left to finish on
# their own.
#
# EXIT is trapped too (not just TERM/INT, cleared again first thing inside
# cleanup so its own `exit 0` doesn't re-trigger it): under `set -eu`, a
# single malformed forwards[$i] entry (e.g. read mid-write by a non-atomic
# config save) makes one `yq` call fail and aborts the whole script - without
# an EXIT trap that orphans every socat already spawned by earlier loop
# iterations, which then holds their listen ports for the next respawn to
# crash-loop against.
cleanup() {
    trap - TERM INT EXIT
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in $pids; do
        wait "$pid" 2>/dev/null || true
    done
    exit 0
}
trap cleanup EXIT TERM INT

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

# router's own IP on code-docker-internal (see docker-compose.yml's
# `forward` alias) - code-docker is attached to the same network (no alias
# of its own needed there) so `forward:<port>` still resolves to router from
# inside code-docker. Used to be a dedicated code-docker-forwards network,
# dropped once forwards+publish both ended up on router with no remaining
# port-namespace collision to guard against - see docker-compose.yml's
# `forward` alias comment for the full reasoning.
FORWARD_IP=$(getent hosts forward | awk '{ print $1; exit }')

# Keeps this program alive on its own even when forwards: is empty -
# otherwise the plain `wait` at the bottom would return immediately with no
# background jobs, and supervisord would see the program exit right away.
sleep infinity &
pids="$pids $!"

# -r on every yq call below: see tailscale-publish.default.sh's comment on
# why (Arch's yq is kislyuk/yq, a jq wrapper - string results come back
# JSON-quoted without it).
socks5=$(yq -r '.socks5_address' "$CONFIG")
default_intervall=$(yq -r '.retry_intervall // 5' "$CONFIG")

# forwards: pull a remote peer's port in via socat + tailscaled's SOCKS5 proxy.
count=$(yq -r '.forwards | length' "$CONFIG")
i=0
while [ "$i" -lt "$count" ]; do
    local_port=$(yq -r ".forwards[$i].local_port" "$CONFIG")
    remote_host=$(yq -r ".forwards[$i].remote_host" "$CONFIG")
    remote_port=$(yq -r ".forwards[$i].remote_port" "$CONFIG")
    intervall=$(yq -r ".forwards[$i].retry_intervall // $default_intervall" "$CONFIG")
    socat TCP-LISTEN:"$local_port",bind="$FORWARD_IP",fork,reuseaddr \
        SOCKS5:"$socks5":"$remote_host":"$remote_port",forever,intervall="$intervall" &
    pids="$pids $!"
    i=$((i + 1))
done

wait
