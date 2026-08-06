#!/bin/sh
set -u

# supervisord program (see config/netgate/supervisord.default.conf) - loops
# forever re-applying netgate's iptables rules from config.yaml, rather than
# a one-shot init step, for two reasons: (1) a forward's target_host can
# resolve to a new IP after the target container restarts, so the DNAT rule
# needs periodic re-resolution, same self-healing idiom as
# script/netinit-entrypoint.sh; (2) code-docker-external's interface may not
# be up yet on the very first iteration, so retrying is simpler than a
# one-shot script with its own polling/timeout logic. See
# .claude/backlog/egress-netgate-plan.md for the overall design.

NETGATE_CONFIG=/etc/code-docker/netgate/config.default.yaml
if [ -e /etc/code-docker/netgate/config.override.yaml ]; then
	NETGATE_CONFIG=/etc/code-docker/netgate/config.override.yaml
fi

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
	default_iface="$(ip -4 route show default 2>/dev/null | awk '{ print $5; exit }')"
	if [ -z "$default_iface" ]; then
		echo >&2 "netgate-firewall: no default route yet (code-docker-external not up?), skipping this cycle"
		return 0
	fi

	# Same technique as script/dind-entrypoint.sh uses to find its
	# code-docker-internal interface: it's whichever interface besides lo
	# and the default-routed one. Assumes exactly two networks, same
	# caveat as dind-entrypoint.sh's own comment.
	internal_iface=""
	for dev in /sys/class/net/*; do
		dev="$(basename "$dev")"
		[ "$dev" = "lo" ] && continue
		[ "$dev" = "$default_iface" ] && continue
		internal_iface="$dev"
		break
	done
	if [ -z "$internal_iface" ]; then
		echo >&2 "netgate-firewall: could not find the code-docker-internal interface, skipping this cycle"
		return 0
	fi

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
	fwd_count=$(yq -r '.forwards | length' "$NETGATE_CONFIG")
	i=0
	while [ "$i" -lt "$fwd_count" ]; do
		host_port=$(yq -r ".forwards[$i].host_port" "$NETGATE_CONFIG")
		target_host=$(yq -r ".forwards[$i].target_host" "$NETGATE_CONFIG")
		target_port=$(yq -r ".forwards[$i].target_port" "$NETGATE_CONFIG")
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

	# squid content-blocklist intercept (see config/netgate/squid.default.conf)
	# - restricted to traffic FROM code-docker-internal only, so inbound
	# host traffic (handled by the forwards: DNAT rules above, arriving on
	# $default_iface) is never redirected into squid by mistake.
	iptables -t nat -A NETGATE-PREROUTING -i "$internal_iface" -p tcp --dport 80 -j REDIRECT --to-port 3129
	iptables -t nat -A NETGATE-PREROUTING -i "$internal_iface" -p tcp --dport 443 -j REDIRECT --to-port 3130

	out_count=$(yq -r '.outbound | length' "$NETGATE_CONFIG")
	i=0
	while [ "$i" -lt "$out_count" ]; do
		action=$(yq -r ".outbound[$i].action" "$NETGATE_CONFIG")
		cidr=$(yq -r ".outbound[$i].cidr" "$NETGATE_CONFIG")
		case "$action" in
		allow) iptables -A NETGATE-FORWARD -d "$cidr" -j ACCEPT ;;
		block) iptables -A NETGATE-FORWARD -d "$cidr" -j DROP ;;
		*) echo >&2 "netgate-firewall: unknown action '$action' for $cidr, skipping" ;;
		esac
		i=$((i + 1))
	done

	echo "netgate-firewall: applied $fwd_count forward(s), $out_count outbound rule(s) (internal=$internal_iface, external=$default_iface)"
}

# net.ipv4.ip_forward=1 is set declaratively via docker-compose.yml's
# sysctls: on this service, not here - `sysctl -w` at runtime fails with
# permission denied even with NET_ADMIN, since Docker keeps /proc/sys
# read-only for non-privileged containers regardless of capabilities. See
# the compose file's own comment on this.

while true; do
	apply_rules || echo >&2 "netgate-firewall: apply_rules failed this cycle, will retry"
	sleep 30
done
