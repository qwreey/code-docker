#!/bin/sh
set -e

# See router/.claude/dns-blocklist-management-plan.md for the full design.
# This script now owns three things dnsmasq needs beyond its static
# dnsmasq.default.conf/.override.conf: the builtin blocklist source's
# bootstrap/reconcile step, the resolver mode/servers override, and
# assembling every managed --addn-hosts= source (custom-hosts + blocklist
# sources) - all three are runtime state under /var/lib/code-docker-router,
# managed by router-manager's own DNS API, not baked into the image.

CONF=/etc/code-docker/dns/dnsmasq.default.conf
if [ -e /etc/code-docker/dns/dnsmasq.override.conf ]; then
    CONF=/etc/code-docker/dns/dnsmasq.override.conf
fi

SOURCES_DIR=/var/lib/code-docker-router/dns/blocklist-sources
MANIFEST=/var/lib/code-docker-router/dns/blocklist-manifest
BUILTIN_TARGET="$SOURCES_DIR/builtin.hosts"
RESOLVER_CONFIG=/var/lib/code-docker-router/dns/config.yaml
CUSTOM_HOSTS=/var/lib/code-docker-router/dns/custom-hosts.hosts

# Seeds/reconciles $BUILTIN_TARGET from blocklist.default.hosts only -
# deliberately NOT the default/override "pick one" priority code-patch.
# default.sh (and every other override pair in this repo) normally uses:
# blocklist.override.hosts has always been documented as an *additional*
# blocklist layered on top of the built-in one (see its own handling below),
# not a replacement for it, and folding it into this seed step would have
# silently reversed that for anyone already relying on it (an override file
# with a handful of extra domains would suddenly *replace* the entire
# ~100k-line StevenBlack default instead of adding to it). So: this seed
# step only ever looks at blocklist.default.hosts, and .override.hosts stays
# exactly as it always was - its own unconditional extra --addn-hosts= flag
# below, independent of $SOURCES_DIR entirely.
#
# The hash-tracking itself is exactly code-patch.default.sh's algorithm:
# missing target -> copy; shipped content unchanged -> no-op; shipped
# content changed AND target still matches what we last seeded (i.e.
# untouched since) -> copy again; shipped content changed AND target has
# diverged (edited via router-manager's DNS tab) -> leave it alone. That
# last case is where this differs from code-patch: instead of silently
# forgetting about it forever, router-manager's own
# GET /api/dns/blocklist-sources/builtin/status recomputes the same
# comparison on every read and surfaces "update available" with
# pull/ignore actions - see internal/dns/blocklist.go's GetBuiltinStatus.
seed_builtin_blocklist() {
    # DNS_BUILTIN_BLOCKLIST_SOURCE lets a deployment bind-mount its own hosts
    # file over the image-shipped default and point this env var at it
    # instead - deploy-time only (env vars need a container recreate to take
    # effect, same as every other env-driven toggle here), so there's no
    # runtime web control for this by design. See example-env.router's own
    # comment on this var.
    source_file="${DNS_BUILTIN_BLOCKLIST_SOURCE:-/etc/code-docker/dns/blocklist.default.hosts}"

    mkdir -p "$SOURCES_DIR"

    prev_hash=""
    if [ -e "$MANIFEST" ]; then
        while read -r line; do
            name=$(printf '%s' "$line" | cut -f1)
            hash=$(printf '%s' "$line" | cut -f2)
            [ "$name" = "builtin" ] && prev_hash="$hash"
        done < "$MANIFEST"
    fi

    desired_hash="$(sha1sum "$source_file" | awk '{print $1}')"

    if [ ! -e "$BUILTIN_TARGET" ]; then
        cp "$source_file" "$BUILTIN_TARGET"
        printf 'builtin\t%s\n' "$desired_hash" > "$MANIFEST"
        return
    fi

    live_hash="$(sha1sum "$BUILTIN_TARGET" | awk '{print $1}')"
    if [ -n "$prev_hash" ] && [ "$live_hash" = "$prev_hash" ]; then
        cp "$source_file" "$BUILTIN_TARGET"
        printf 'builtin\t%s\n' "$desired_hash" > "$MANIFEST"
    fi
}

# DNS_BUILTIN_BLOCKLIST_ENABLED="false" opts out of the image-shipped
# StevenBlack/hosts builtin source entirely - a manifest entry and a stray
# $BUILTIN_TARGET from a time this was enabled would otherwise keep getting
# globbed into extra_args below forever, so this actively removes both
# rather than just skipping the seed step going forward. Custom sources
# (added via the DNS tab) and blocklist.override.hosts are untouched either
# way - both are independent of $SOURCES_DIR's builtin entry.
if [ "${DNS_BUILTIN_BLOCKLIST_ENABLED:-true}" = "false" ]; then
    rm -f "$BUILTIN_TARGET"
    if [ -e "$MANIFEST" ]; then
        # Same tab-separated "<name>\t<hash>" format seed_builtin_blocklist's
        # own read loop parses above - filtered with cut rather than a
        # grep/sed tab-literal pattern for the same portability reasons that
        # loop already avoids embedding one.
        : > "$MANIFEST.tmp"
        while read -r line; do
            name=$(printf '%s' "$line" | cut -f1)
            [ "$name" = "builtin" ] && continue
            printf '%s\n' "$line" >> "$MANIFEST.tmp"
        done < "$MANIFEST"
        mv "$MANIFEST.tmp" "$MANIFEST"
    fi
else
    seed_builtin_blocklist
fi

# extra_args is intentionally left unquoted when passed to dnsmasq below
# (same word-splitting-on-purpose idiom netgate-firewall.default.sh's own
# argument building uses) - every piece appended here is a whole flag with
# no embedded whitespace (a fixed path or an IP literal), so splitting on
# spaces is exactly what's wanted, and POSIX sh (unlike bash) has no arrays
# to build this list with instead.
extra_args=""

# Resolver override - "auto" (default, missing config, or malformed config
# all behave the same way: fall through to dnsmasq.default.conf's own
# resolv-file=/etc/resolv.conf) vs "custom" (a fixed upstream list, e.g.
# 1.1.1.1 - confirmed feasible in userspace, see the plan doc). A read/parse
# failure degrades to auto rather than failing dnsmasq's startup entirely.
if [ -e "$RESOLVER_CONFIG" ]; then
    mode="$(yq -r '.resolver.mode // "auto"' "$RESOLVER_CONFIG" 2>/dev/null || echo auto)"
    if [ "$mode" = "custom" ]; then
        extra_args="$extra_args --no-resolv"
        count="$(yq -r '.resolver.servers | length' "$RESOLVER_CONFIG" 2>/dev/null || echo 0)"
        i=0
        while [ "$i" -lt "${count:-0}" ] 2>/dev/null; do
            server="$(yq -r ".resolver.servers[$i]" "$RESOLVER_CONFIG" 2>/dev/null)"
            [ -n "$server" ] && extra_args="$extra_args --server=$server"
            i=$((i + 1))
        done
    fi
fi

# Custom hosts (MagicDNS-style real IP mappings) load before every
# blocklist-type source below (this file, blocklist.override.hosts, and
# $SOURCES_DIR) - a fixed precedence decision, not a user-configurable
# order: if a hostname is explicitly mapped here, that intent should win
# over an incidental block. See the plan doc's "블록리스트와 추가 호스트가
# 같은 호스트 이름을 가리키면?" for why this isn't fully resolved (dnsmasq's
# own multi-file-hosts precedence isn't strictly documented) and why
# router-manager's own list API separately surfaces a duplicateHosts
# warning instead of pretending this ordering is a guarantee.
if [ -e "$CUSTOM_HOSTS" ]; then
    extra_args="$extra_args --addn-hosts=$CUSTOM_HOSTS"
fi

# blocklist.override.hosts - unconditional extra layer, always additive on
# top of the builtin source above (never its replacement) - the same
# behavior this had before router-manager's own DNS tab existed. Not part
# of $SOURCES_DIR/not hash-tracked: it's a pure file-based escape hatch for
# anyone who'd rather keep managing this outside the web UI.
if [ -e /etc/code-docker/dns/blocklist.override.hosts ]; then
    extra_args="$extra_args --addn-hosts=/etc/code-docker/dns/blocklist.override.hosts"
fi

# Every blocklist source (builtin + any custom ones added via the DNS tab)
# becomes its own --addn-hosts= flag - dnsmasq accepts the flag repeated,
# already relied on before this script existed (the old blocklist.override.
# hosts handling). Order among these doesn't matter: blocking is blocking
# regardless of which file supplied it, so no ambiguity here the way there
# is with $CUSTOM_HOSTS above.
if [ -d "$SOURCES_DIR" ]; then
    for f in "$SOURCES_DIR"/*.hosts; do
        [ -e "$f" ] || continue
        extra_args="$extra_args --addn-hosts=$f"
    done
fi

exec dnsmasq --conf-file="$CONF" $extra_args
