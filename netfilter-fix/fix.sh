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

set -eu

NETWORK_NAME="${CODE_DOCKER_INTERNAL_NETWORK:-code-docker-internal}"
COMMENT_TAG="code_docker_internal_forward_fix"

current_bridge() {
	net_id="$(curl -sf --unix-socket /var/run/docker.sock "http://localhost/networks/${NETWORK_NAME}" | jq -r '.Id' 2>/dev/null)" || return 1
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

cleanup_stale_rules() {
	live_bridge="$1"
	list_own_rules | while IFS= read -r line; do
		iface="$(printf '%s\n' "$line" | sed -n 's/.*iifname "\([^"]*\)".*/\1/p')"
		handle="$(printf '%s\n' "$line" | sed -n 's/.*# handle \([0-9]*\).*/\1/p')"
		[ "$iface" = "$live_bridge" ] && continue
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

echo "netfilter-fix: watching network '${NETWORK_NAME}'"
while true; do
	bridge="$(current_bridge || true)"
	if [ -n "${bridge:-}" ] && ip link show "$bridge" >/dev/null 2>&1; then
		ensure_rule "$bridge"
		cleanup_stale_rules "$bridge"
	else
		echo >&2 "netfilter-fix: network '${NETWORK_NAME}' not up yet, skipping this cycle"
	fi
	sleep 30 &
	wait $!
done
