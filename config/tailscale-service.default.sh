#!/bin/bash
set -e

if [ "${TAILSCALE_ENABLED:-true}" = "false" ]; then
    echo "Tailscale not enabled by environment"
    sleep infinity &
    sleep_pid=$!
    trap 'kill "$sleep_pid" 2>/dev/null || true' TERM INT
    wait "$sleep_pid"
    exit 0
fi

# See tailscale.md at the repo root for why userspace networking (no
# NET_ADMIN/tun) is used, and how inbound/outbound forwarding work without it.
mkdir -p /code/.tailscale/state

/usr/bin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1055 \
    --state=/code/.tailscale/state/tailscaled.state &
tailscaled_pid=$!

until [ -S /var/run/tailscale/tailscaled.sock ]; do
    sleep 1
done

# First boot (or a wiped state dir) needs a login; interactive auth prints
# the URL to this program's log. Once logged in, state persists in /code so
# this is a no-op on subsequent starts.
backend_state=$(tailscale status --json | yq -r '.BackendState')
if [ "$backend_state" != "Running" ]; then
    tailscale_up_args=()
    if [ -n "${TAILSCALE_LOGIN_SERVER:-}" ]; then
        tailscale_up_args+=(--login-server="$TAILSCALE_LOGIN_SERVER")
    fi
    tailscale up "${tailscale_up_args[@]}"
fi

wait "$tailscaled_pid"
