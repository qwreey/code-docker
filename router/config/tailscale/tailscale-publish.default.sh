#!/bin/sh
set -eu

# Split out of the old combined tailscale-forward.default.sh (forwards+
# publish) per functional-router-plan.md's single-responsibility-program
# principle - see tailscale-forward.default.sh for the forwards half.
#
# Previously (when tailscaled ran inside code-docker itself) `publish:`
# targeted code-docker's own `private` alias, needed only to dodge
# tailscaled's automatic loopback/0.0.0.0 re-exposure of ITS OWN container.
# Now that tailscaled lives in router - a different container - each
# publish entry names its own target_host (any hostname/IP reachable from
# router on code-docker-internal - a plain compose service hostname works
# the same way code-docker's does, no dedicated alias needed). Entries
# written before target_host existed have no such field in the YAML; yq
# returns "null" for a missing key, so that's treated the same as an empty
# value below and falls back to "code-docker" for compatibility.
DEFAULT_PUBLISH_TARGET_HOST=code-docker

CONFIG=/var/lib/code-docker-router/tailscale/config.yaml
mkdir -p /var/lib/code-docker-router/tailscale
if [ ! -e "$CONFIG" ]; then
    if [ -e /etc/router/tailscale-config.override.yaml ]; then
        cp /etc/router/tailscale-config.override.yaml "$CONFIG"
    else
        cp /etc/router/tailscale-config.default.yaml "$CONFIG"
    fi
fi

trap 'exit 0' TERM INT

if [ "${TAILSCALE_ENABLED:-true}" = "false" ]; then
    echo "Tailscale not enabled by environment"
    while true; do sleep 3600; done
fi

until tailscale status --json 2>/dev/null | yq -e '.BackendState == "Running"' >/dev/null 2>&1; do
    sleep 1
done

# publish: `tailscale serve` rules are declarative state kept by tailscaled,
# so reset then reapply from the YAML on every start - this makes entries
# removed from the YAML actually get torn down.
#
# Every yq call below needs -r: Arch's `yq` package is kislyuk/yq (a Python
# wrapper around jq), not mikefarah/yq - string results come back
# JSON-quoted (e.g. `"tcp"`, literal quote characters and all) without -r,
# which silently breaks flags/args built from them (`--"tcp"=...` is not a
# valid `tailscale serve` flag). See netgate/firewall.default.sh for the
# same convention already followed there.
tailscale serve reset
count=$(yq -r '.publish | length' "$CONFIG")
i=0
while [ "$i" -lt "$count" ]; do
    tport=$(yq -r ".publish[$i].tailscale_port" "$CONFIG")
    lport=$(yq -r ".publish[$i].local_port" "$CONFIG")
    mode=$(yq -r ".publish[$i].mode // \"tcp\"" "$CONFIG")
    thost=$(yq -r ".publish[$i].target_host // \"\"" "$CONFIG")
    thost=${thost:-$DEFAULT_PUBLISH_TARGET_HOST}
    tailscale serve --bg --"$mode"="$tport" "tcp://$thost:$lport"
    i=$((i + 1))
done

# This program has nothing left to actively do once serve rules are applied
# (tailscaled itself owns the actual proxying) - stay alive so supervisord
# doesn't treat a normal exit as a crash, and so a config.yaml change can be
# picked up via a plain restart (see bin/forward-reload's router equivalent,
# once it exists).
while true; do sleep 3600; done
