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

# See docs/tailscale.md at the repo root for why userspace networking (no
# NET_ADMIN/tun) is used, and how inbound/outbound forwarding work without
# it. State lives under router's own persistent volume now (moved here from
# code-docker's /code - see .claude/functional-router-plan.md's
# "tailscale 전체 이관").
mkdir -p /var/lib/code-docker-router/tailscale/state

/usr/bin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1055 \
    --state=/var/lib/code-docker-router/tailscale/state/tailscaled.state &
tailscaled_pid=$!

# supervisord only signals this script's own PID, not its process group, so
# without an explicit trap `tailscaled` (and a still-pending `tailscale up`
# below) survive as orphans holding the daemon socket/state whenever this
# program is stopped or restarted - the next spawn then crash-loops trying
# to rebind a socket the orphan is still holding (observed firsthand: a
# `supervisorctl restart tailscaled` left both processes running, and
# supervisord gave up after a few failed respawns). Same shape as
# tailscale-forward.default.sh's own cleanup(). `tailscale up` is run
# backgrounded + waited-on below (not as a plain foreground command)
# specifically so this trap stays responsive even while it's blocked on an
# incomplete login - bash defers a trap until the current foreground
# command exits, but interrupts a `wait` immediately.
pids="$tailscaled_pid"
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

until [ -S /var/run/tailscale/tailscaled.sock ]; do
    sleep 1
done

# First boot (or a wiped state dir) needs a login; interactive auth prints
# the URL to this program's log. Once logged in, state persists in router's
# own volume so this is a no-op on subsequent starts.
#
# The auto-attempt below only ever fires once per state dir (guarded by
# LOGIN_ATTEMPTED_MARKER) rather than on every restart - `tailscale up` with
# no --timeout blocks until login succeeds or the process is killed, so a
# container repeatedly stopped/started before the user finishes logging in
# would otherwise register a fresh pending auth request with the control
# server every single boot (a mild self-DDoS against it). After this one
# attempt, further retries are on-demand only: webmanager's Tailscale tab
# ("로그인 시도하기") or the code-server sign-in banner's link to it - see
# tailscale-notify.default.js and router-manager's tailscale login-start API
# (once it exists - see router/plan.md).
# The marker lives inside state/ (not a sibling) so the documented "wipe
# the tailscale state dir and restart" procedure for changing login servers
# naturally re-arms this auto-attempt too, with no extra doc to keep in sync.
LOGIN_ATTEMPTED_MARKER=/var/lib/code-docker-router/tailscale/state/.login-attempted
backend_state=$(tailscale status --json | yq -r '.BackendState')
if [ "$backend_state" != "Running" ]; then
    if [ -e "$LOGIN_ATTEMPTED_MARKER" ]; then
        echo "Tailscale login required - already attempted automatically once; retry from webmanager's Tailscale tab"
    else
        touch "$LOGIN_ATTEMPTED_MARKER"
        tailscale_up_args=()
        if [ -n "${TAILSCALE_LOGIN_SERVER:-}" ]; then
            tailscale_up_args+=(--login-server="$TAILSCALE_LOGIN_SERVER")
        fi
        if [ -n "${TAILSCALE_HOSTNAME:-}" ]; then
            tailscale_up_args+=(--hostname="$TAILSCALE_HOSTNAME")
        fi
        tailscale up "${tailscale_up_args[@]}" &
        up_pid=$!
        pids="$pids $up_pid"
        # A failed/timed-out login attempt (e.g. no network route to the
        # control server) must not tear down the whole program via set -e -
        # tailscaled and the forwards/publish that depend on it should keep
        # running regardless, exactly as before this trap existed.
        wait "$up_pid" || echo "Tailscale login attempt did not complete (exit $?)"
        pids="$tailscaled_pid"
    fi
fi

wait "$tailscaled_pid"
