#!/bin/sh
set -eu

# Split out of the old combined tailscale-forward.default.sh (forwards+
# publish) per functional-router-plan.md's single-responsibility-program
# principle - see tailscale-forward.default.sh for the forwards half.
#
# Previously (when tailscaled ran inside code-docker itself) `publish:`
# targeted code-docker's own `private` alias, needed only to dodge
# tailscaled's automatic loopback/0.0.0.0 re-exposure of ITS OWN container.
# Now that tailscaled lives in router - a different container - `publish:`
# targets code-docker directly by its plain compose service hostname over
# code-docker-internal (router is attached there too) - no dedicated alias
# needed on code-docker's side for this anymore. Schema (tailscale_port/
# local_port/mode, no target_host) is unchanged for now since code-docker is
# the only publish target in practice; generalize with a target_host field
# if router ever needs to publish some other internal service's port.
PUBLISH_TARGET_HOST=code-docker

CONFIG=/var/lib/code-docker-router/tailscale/config.yaml
mkdir -p /var/lib/code-docker-router/tailscale
if [ ! -e "$CONFIG" ]; then
    if [ -e /etc/code-docker/tailscale-config.override.yaml ]; then
        cp /etc/code-docker/tailscale-config.override.yaml "$CONFIG"
    else
        cp /etc/code-docker/tailscale-config.default.yaml "$CONFIG"
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
tailscale serve reset
count=$(yq '.publish | length' "$CONFIG")
i=0
while [ "$i" -lt "$count" ]; do
    tport=$(yq ".publish[$i].tailscale_port" "$CONFIG")
    lport=$(yq ".publish[$i].local_port" "$CONFIG")
    mode=$(yq ".publish[$i].mode // \"tcp\"" "$CONFIG")
    tailscale serve --bg --"$mode"="$tport" "tcp://$PUBLISH_TARGET_HOST:$lport"
    i=$((i + 1))
done

# This program has nothing left to actively do once serve rules are applied
# (tailscaled itself owns the actual proxying) - stay alive so supervisord
# doesn't treat a normal exit as a crash, and so a config.yaml change can be
# picked up via a plain restart (see bin/forward-reload's router equivalent,
# once it exists).
while true; do sleep 3600; done
