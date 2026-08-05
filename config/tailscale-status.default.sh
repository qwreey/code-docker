#!/bin/sh
set -eu

if [ "${TAILSCALE_ENABLED:-true}" = "false" ]; then
    echo "Tailscale not enabled by environment"
    sleep infinity &
    sleep_pid=$!
    trap 'kill "$sleep_pid" 2>/dev/null || true' TERM INT
    wait "$sleep_pid"
    exit 0
fi

# Snapshot of the pending sign-in URL (if any) for tailscale-notify.js (see
# user-init.default.sh) to poll - lets code-server itself surface it as a
# browser notification instead of only appearing in `docker compose logs`.
# Runs independently of tailscaled's login state and tailscale-forward's
# forwards/publish setup, so neither has to care about this.
STATUS_FILE=/code/.local/share/code-docker/code/patch/tailscale/status.json
write_status() {
    status=$(tailscale status --json 2>/dev/null) || return 0
    mkdir -p "$(dirname "$STATUS_FILE")"
    echo "$status" | yq -c '{backendState: .BackendState, authUrl: (.AuthURL // null)}' \
        > "$STATUS_FILE.tmp" 2>/dev/null && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

trap 'exit 0' TERM INT

while true; do
    write_status
    sleep 2
done
