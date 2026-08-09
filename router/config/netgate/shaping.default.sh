#!/bin/sh
set -u

# supervisord program (see config/netgate/supervisord.default.conf) - loops
# forever re-applying netgate's tc HTB bandwidth-shaping tree from
# config.yaml's own `bandwidth:` section, same self-healing/live-config-poll
# idiom firewall.default.sh already uses for outbound/forwards (see that
# script's own comment on why this is a loop, not a one-shot). Kept as its
# own program/script rather than folded into firewall.default.sh - iptables
# (netfilter, this container's FORWARD/PREROUTING/POSTROUTING chains) and tc
# (the queueing discipline on one interface) are two independent kernel
# subsystems with their own failure modes, and this only ever touches
# $default_iface's qdisc tree.

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

# Root class's rate/ceil when no total_mbps cap is configured but at least
# one per-service limit is - HTB needs a real parent rate to lend bandwidth
# from, so this stands in for "unlimited" instead of special-casing a
# parentless tree. Comfortably above anything this container's own NIC
# could push, so it never becomes the real bottleneck on its own.
UNLIMITED_MBIT=10000

apply_shaping() {
	NETGATE_CONFIG="$(resolve_config_path)"
	default_iface="$(ip -4 route show default 2>/dev/null | awk '{ print $5; exit }')"
	if [ -z "$default_iface" ]; then
		echo >&2 "netgate-shaping: no default route yet (code-docker-external not up?), skipping this cycle"
		return 0
	fi

	# Same single-snapshot-per-cycle reasoning as firewall.default.sh's own
	# config_snapshot - router-manager's config writes are atomic, so every
	# yq call below sees the same consistent version of the file.
	config_snapshot="$(cat "$NETGATE_CONFIG" 2>/dev/null)"
	total_mbps=$(printf '%s' "$config_snapshot" | yq -r '.bandwidth.total_mbps // 0' 2>/dev/null)
	total_mbps="${total_mbps:-0}"
	case "$total_mbps" in '' | *[!0-9]*) total_mbps=0 ;; esac
	svc_count=$(printf '%s' "$config_snapshot" | yq -r '.bandwidth.services | length' 2>/dev/null)
	svc_count="${svc_count:-0}"
	case "$svc_count" in '' | *[!0-9]*) svc_count=0 ;; esac

	# Rebuild from scratch every cycle - same accepted trade-off
	# firewall.default.sh documents for its own flush+rebuild (a brief
	# window with no rules applied at all), see that script's own comment.
	# Not atomic, but simple, and this only runs every 30s.
	tc qdisc del dev "$default_iface" root >/dev/null 2>&1

	if [ "$total_mbps" -le 0 ] && [ "$svc_count" -le 0 ]; then
		echo "netgate-shaping: no bandwidth limit configured, leaving $default_iface unshaped"
		return 0
	fi

	root_mbit="$total_mbps"
	if [ "$root_mbit" -le 0 ]; then
		root_mbit="$UNLIMITED_MBIT"
	fi

	tc qdisc add dev "$default_iface" root handle 1: htb default 999
	tc class add dev "$default_iface" parent 1: classid 1:1 htb rate "${root_mbit}mbit" ceil "${root_mbit}mbit"
	# Catch-all for traffic that doesn't match any per-service filter below
	# (including this router's own traffic, since a qdisc shapes everything
	# leaving the interface, not just FORWARDed packets) - a negligible
	# guaranteed floor, free to borrow up to the shared root ceiling.
	tc class add dev "$default_iface" parent 1:1 classid 1:999 htb rate 1kbit ceil "${root_mbit}mbit"

	i=0
	classid=10
	while [ "$i" -lt "$svc_count" ]; do
		target_host=$(printf '%s' "$config_snapshot" | yq -r ".bandwidth.services[$i].target_host")
		limit_mbps=$(printf '%s' "$config_snapshot" | yq -r ".bandwidth.services[$i].limit_mbps")
		target_ip="$(getent hosts "$target_host" 2>/dev/null | awk '{ print $1; exit }')"
		case "${limit_mbps:-}" in '' | *[!0-9]*) limit_mbps=0 ;; esac
		if [ -n "$target_ip" ] && [ "$limit_mbps" -gt 0 ]; then
			# rate == ceil - a genuine hard cap per service, deliberately not
			# allowed to borrow from the shared root class even when it has
			# spare capacity (an independent hard limit per container, not
			# just a guaranteed minimum).
			tc class add dev "$default_iface" parent 1:1 classid "1:$classid" htb rate "${limit_mbps}mbit" ceil "${limit_mbps}mbit"
			tc filter add dev "$default_iface" parent 1: protocol ip prio 1 u32 match ip src "$target_ip/32" flowid "1:$classid"
		else
			echo >&2 "netgate-shaping: service #$i ('$target_host') does not resolve yet or has an invalid limit, skipping this cycle"
		fi
		i=$((i + 1))
		classid=$((classid + 1))
	done

	echo "netgate-shaping: applied total=${total_mbps}mbps (root=${root_mbit}mbit), $svc_count service limit(s) on $default_iface"
}

# Same NETGATE_ENABLED behavioral opt-out netgate-firewall.sh uses - see
# that script's own comment (root CLAUDE.md's "netgate (egress lockdown)").
# Bandwidth shaping is part of the same feature area (network-exhaustion
# defense alongside destination-based filtering), so it idles the same way.
if [ "${NETGATE_ENABLED:-true}" = "false" ]; then
	echo "netgate-shaping: NETGATE_ENABLED=false, idling without applying any shaping"
	exec sleep infinity
fi

while true; do
	apply_shaping || echo >&2 "netgate-shaping: apply_shaping failed this cycle, will retry"
	sleep 30
done
