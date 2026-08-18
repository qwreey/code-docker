#!/bin/sh
# See docs/egress-netgate.md's "Docker의 DOCKER-INTERNAL 강제 격리" section for the
# full story of why this exists. Short version: newer Docker Engine builds install a
# DOCKER-INTERNAL nftables chain for any `internal: true` network that unconditionally
# drops FORWARD-path packets leaving that network's bridge whose destination isn't inside
# the bridge's own subnet - this blocks router's whole egress design at the host level,
# regardless of what router's own iptables does internally. DOCKER-USER is the chain
# Docker reserves for exactly this kind of override, always evaluated before
# DOCKER-FORWARD/DOCKER-INTERNAL.
#
# Runs with network_mode: host (see docker-compose.yml) so it can reach the host's own
# network namespace/netfilter tables at all - a container's NET_ADMIN only grants admin
# rights within its OWN netns otherwise, same reason code-docker's own NET_ADMIN-less
# netns can't touch this itself. Uses `nft` directly instead of the `iptables`
# compatibility layer so there's no ambiguity about which backend (legacy xtables vs
# nftables) actually gets written - dockerd manages DOCKER-USER natively via nftables
# (confirmed via `nft list ruleset` on the affected host), so this talks to the exact
# same objects with no translation layer in between.
#
# The internal network's bridge name (br-<first 12 hex chars of the network ID>) changes
# across `docker compose down`/`up` cycles, so this re-resolves it every cycle and cleans
# up any rule left over from a previous incarnation - the same reconcile-loop idiom
# router/config/netgate/firewall.default.sh uses inside the router container itself.
#
# On SIGTERM/SIGINT (i.e. `docker compose down` or `docker compose stop`), removes every
# rule it added before exiting - the exemption's lifetime is tied to this container's own,
# so tearing down the stack doesn't leave a stale DOCKER-USER ACCEPT sitting on a host that
# no longer needs it.
#
# NETWORK_NAMES is a space-separated list, not a single name - CODE_DOCKER_INTERNAL_NETWORK
# (always present, defaults to code-docker-internal) is the one this project itself depends
# on, and CODE_DOCKER_EXTRA_INTERNAL_NETWORKS is for anything a sibling project's
# EXTRA_INCLUDE overlay (see docker-compose.yml's `include:` comment and
# .claude/archive/roblox-studio-vnc-isolation-plan-done.md) attaches router to - e.g. a
# VNC-only `internal: true` network. Kept as two separate env vars deliberately: a sibling
# overlay setting CODE_DOCKER_EXTRA_INTERNAL_NETWORKS can never accidentally clobber this
# project's own default exemption, since Compose environment merging replaces a key's value
# wholesale rather than appending to it.

set -eu

NETWORK_NAME="${CODE_DOCKER_INTERNAL_NETWORK:-code-docker-internal}"
NETWORK_NAMES="$NETWORK_NAME ${CODE_DOCKER_EXTRA_INTERNAL_NETWORKS:-}"
COMMENT_TAG="code_docker_internal_forward_fix"

current_bridge() {
	name="$1"
	net_id="$(curl -sf --unix-socket /var/run/docker.sock "http://localhost/networks/${name}" | jq -r '.Id' 2>/dev/null)" || return 1
	[ -n "$net_id" ] && [ "$net_id" != "null" ] || return 1
	printf 'br-%.12s\n' "$net_id"
}

list_own_rules() {
	nft -a list chain ip filter DOCKER-USER 2>/dev/null | grep -F "comment \"${COMMENT_TAG}\"" || true
}

ensure_rule() {
	bridge="$1"
	list_own_rules | grep -q "iifname \"${bridge}\"" && return 0
	nft insert rule ip filter DOCKER-USER iifname "$bridge" accept comment "\"${COMMENT_TAG}\""
}

delete_by_handle() {
	handle="$1"
	[ -n "$handle" ] && nft delete rule ip filter DOCKER-USER handle "$handle" 2>/dev/null || true
}

is_live_bridge() {
	needle="$1"
	for b in $live_bridges; do
		[ "$b" = "$needle" ] && return 0
	done
	return 1
}

cleanup_stale_rules() {
	live_bridges="$1"
	list_own_rules | while IFS= read -r line; do
		iface="$(printf '%s\n' "$line" | sed -n 's/.*iifname "\([^"]*\)".*/\1/p')"
		handle="$(printf '%s\n' "$line" | sed -n 's/.*# handle \([0-9]*\).*/\1/p')"
		is_live_bridge "$iface" && continue
		delete_by_handle "$handle"
	done
}

remove_all_own_rules() {
	list_own_rules | while IFS= read -r line; do
		handle="$(printf '%s\n' "$line" | sed -n 's/.*# handle \([0-9]*\).*/\1/p')"
		delete_by_handle "$handle"
	done
}

trap 'echo "netfilter-fix: shutting down, removing rule(s)"; remove_all_own_rules; exit 0' TERM INT

echo "netfilter-fix: watching network(s) '${NETWORK_NAMES}'"
while true; do
	live_bridges=""
	for net in $NETWORK_NAMES; do
		bridge="$(current_bridge "$net" || true)"
		if [ -n "${bridge:-}" ] && ip link show "$bridge" >/dev/null 2>&1; then
			ensure_rule "$bridge"
			live_bridges="$live_bridges $bridge"
		else
			echo >&2 "netfilter-fix: network '${net}' not up yet, skipping this cycle"
		fi
	done
	# Only reconcile when at least one network resolved this cycle - if all of them
	# temporarily failed (e.g. a docker.sock blip), leave existing rules alone rather
	# than purging every exemption this container has ever installed, same
	# fail-safe-not-fail-open posture the original single-network version had (it
	# simply skipped ensure_rule/cleanup_stale_rules entirely on a resolve failure).
	if [ -n "$live_bridges" ]; then
		cleanup_stale_rules "$live_bridges"
	fi
	sleep 30 &
	wait $!
done
