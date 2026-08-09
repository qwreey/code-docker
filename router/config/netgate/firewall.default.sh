#!/bin/sh
set -u

# supervisord program (see config/netgate/supervisord.default.conf) - loops
# forever re-applying netgate's iptables rules from config.yaml, rather than
# a one-shot init step, for two reasons: (1) a forward's target_host can
# resolve to a new IP after the target container restarts, so the DNAT rule
# needs periodic re-resolution, same self-healing idiom as
# netinit/script/netinit-entrypoint.sh; (2) code-docker-external's interface may not
# be up yet on the very first iteration, so retrying is simpler than a
# one-shot script with its own polling/timeout logic. See
# .claude/backlog/egress-netgate-plan.md for the overall design.

# resolve_config_path is called fresh every loop iteration (not once at
# script start) so this picks up the live, web-editable copy
# router-manager's Net 관리 탭 reads/writes (see
# router/backend/internal/netgate) as soon as router-manager has seeded it
# - netgate-firewall and router-manager are separate supervisord programs
# with no ordering guarantee between them, so this script can easily start
# first and would otherwise be stuck on the fallback path forever. Falls
# back to the old file-only selection only for the brief window before
# router-manager has run for the first time (or if it's ever disabled) -
# this keeps existing config.override.yaml-only deployments working
# unmodified until a live copy exists.
resolve_config_path() {
	live=/var/lib/code-docker-router/netgate/config.yaml
	if [ -e "$live" ]; then
		echo "$live"
	elif [ -e /etc/router/netgate/config.override.yaml ]; then
		echo /etc/router/netgate/config.override.yaml
	else
		echo /etc/router/netgate/config.default.yaml
	fi
}

# Each cycle flushes and rebuilds netgate's own chains (see apply_rules
# below) - this is idempotent but not atomic, so there's a brief window
# every cycle where the rebuilt chain is empty and FORWARD's default ACCEPT
# policy applies unfiltered. Same accepted trade-off qdm12/gluetun's
# firewall documents for the same pattern (their iptables rules apply after
# Docker's own network init, leaving a similar small window) - see the plan
# doc's research notes. Not attempting an atomic chain swap here to keep
# this script simple; revisit if the window ever proves large enough to
# matter in practice.
ensure_chain() {
	iptables -t "$1" -N "$2" 2>/dev/null || iptables -t "$1" -F "$2"
}

ensure_jump() {
	iptables -t "$1" -C "$2" -j "$3" 2>/dev/null || iptables -t "$1" -I "$2" 1 -j "$3"
}

apply_rules() {
	NETGATE_CONFIG="$(resolve_config_path)"
	default_iface="$(ip -4 route show default 2>/dev/null | awk '{ print $5; exit }')"
	if [ -z "$default_iface" ]; then
		echo >&2 "netgate-firewall: no default route yet (code-docker-external not up?), skipping this cycle"
		return 0
	fi

	# Snapshot the config once per cycle instead of letting every yq call
	# below re-open $NETGATE_CONFIG from disk independently: router-manager's
	# own config writes are now atomic (temp file + rename, see
	# internal/netgate's save()), so a single read here always sees either
	# the old or the new file in full - never a torn/partial one - and every
	# field extracted below is consistent with every other field from the
	# same cycle, which N independent re-reads couldn't guarantee.
	config_snapshot="$(cat "$NETGATE_CONFIG" 2>/dev/null)"

	ensure_chain filter NETGATE-FORWARD
	ensure_jump filter FORWARD NETGATE-FORWARD
	ensure_chain nat NETGATE-PREROUTING
	ensure_jump nat PREROUTING NETGATE-PREROUTING
	ensure_chain nat NETGATE-POSTROUTING
	ensure_jump nat POSTROUTING NETGATE-POSTROUTING

	iptables -t nat -A NETGATE-POSTROUTING -o "$default_iface" -j MASQUERADE

	# Stateful accept, always first: without this, RETURN traffic for any
	# already-permitted connection (e.g. the forwards: DNAT reply below, or
	# a code-docker outbound connection that was allowed on its way out)
	# gets re-evaluated by the ordered outbound: rules below on its way
	# back - and since Docker's own bridge subnets (code-docker-internal,
	# code-docker-external) are themselves RFC1918 addresses, that reply
	# traffic would get dropped by our own block rules. Confirmed by
	# testing: the forwards: DNAT to code-docker:80 matched correctly on
	# the way in, but the connection hung until this rule was added -
	# established/related bypassing re-evaluation is standard stateful
	# firewall practice and does not weaken NEW-connection filtering below
	# (a fresh SYN from code-docker to a private IP still hits NEW state
	# and gets evaluated normally).
	iptables -A NETGATE-FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

	# Port forwards first - each one's FORWARD ACCEPT must land before the
	# outbound: block rules below, since target_host's own address is
	# typically itself in RFC1918 range (see config.default.yaml's
	# comment and the plan doc's "인바운드" section).
	fwd_count=$(printf '%s' "$config_snapshot" | yq -r '.forwards | length' 2>/dev/null)
	# Both a yq failure (nonzero exit, e.g. malformed YAML) and yq succeeding
	# with empty output (e.g. $config_snapshot itself was empty - the config
	# file doesn't exist yet) must fall back to 0 - an empty $fwd_count would
	# otherwise make the `[ "$i" -lt "$fwd_count" ]` test below error out.
	fwd_count="${fwd_count:-0}"
	i=0
	while [ "$i" -lt "$fwd_count" ]; do
		host_port=$(printf '%s' "$config_snapshot" | yq -r ".forwards[$i].host_port")
		target_host=$(printf '%s' "$config_snapshot" | yq -r ".forwards[$i].target_host")
		target_port=$(printf '%s' "$config_snapshot" | yq -r ".forwards[$i].target_port")
		target_ip="$(getent hosts "$target_host" 2>/dev/null | awk '{ print $1; exit }')"
		if [ -n "$target_ip" ]; then
			# -i "$default_iface" restricts this to traffic actually
			# arriving from the host/internet side - without it, an
			# outbound connection FROM code-docker-internal to some
			# unrelated host:80 on the internet would also match
			# --dport 80 and get DNATed back to target_host by mistake.
			iptables -t nat -A NETGATE-PREROUTING -i "$default_iface" -p tcp --dport "$host_port" -j DNAT --to-destination "$target_ip:$target_port"
			iptables -A NETGATE-FORWARD -d "$target_ip" -p tcp --dport "$target_port" -j ACCEPT
		else
			echo >&2 "netgate-firewall: forward #$i target '$target_host' does not resolve yet, skipping this cycle"
		fi
		i=$((i + 1))
	done

	out_count=$(printf '%s' "$config_snapshot" | yq -r '.outbound | length' 2>/dev/null)
	out_count="${out_count:-0}"
	i=0
	while [ "$i" -lt "$out_count" ]; do
		action=$(printf '%s' "$config_snapshot" | yq -r ".outbound[$i].action")
		cidr=$(printf '%s' "$config_snapshot" | yq -r ".outbound[$i].cidr")
		case "$action" in
		allow) iptables -A NETGATE-FORWARD -d "$cidr" -j ACCEPT ;;
		block) iptables -A NETGATE-FORWARD -d "$cidr" -j DROP ;;
		*) echo >&2 "netgate-firewall: unknown action '$action' for $cidr, skipping" ;;
		esac
		i=$((i + 1))
	done

	echo "netgate-firewall: applied $fwd_count forward(s), $out_count outbound rule(s) (external=$default_iface)"
}

# net.ipv4.ip_forward=1 is set declaratively via docker-compose.yml's
# sysctls: on this service, not here - `sysctl -w` at runtime fails with
# permission denied even with NET_ADMIN, since Docker keeps /proc/sys
# read-only for non-privileged containers regardless of capabilities. See
# the compose file's own comment on this.

# Scoped here (not in netgate-entrypoint.sh, which used to `exec sleep
# infinity` for the whole router container the moment this was false) -
# NETGATE_ENABLED is meant to be a behavioral opt-out for egress filtering
# specifically, same tier as TAILSCALE_ENABLED/CADDY_ADAPTER_ENABLED, each
# of which only idles its own program. The old container-wide placement
# meant flipping this off also silently killed DNS/tailscale/Dev Proxy/
# tinyauth/router-manager itself, none of which have any relation to egress
# filtering. See root CLAUDE.md's code-quality audit.
if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
	echo "netgate-firewall: NETGATE_ENABLED=false, idling without applying any firewall rules"
	exec sleep infinity
fi

while true; do
	apply_rules || echo >&2 "netgate-firewall: apply_rules failed this cycle, will retry"
	sleep 30
done
