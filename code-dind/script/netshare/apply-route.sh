# apply_default_route <router-hostname>
#
# Resolves <router-hostname> and, if it answers, `ip route replace`s the
# default route to it. Also warns (stderr, non-fatal) if a second/
# unexpected default route shows up alongside it - never auto-reverts a
# deliberate topology change (e.g. code-docker-external re-attached), only
# logs. Returns 0 if the hostname resolved (route applied), 1 if it
# didn't (caller's loop just tries again next tick).
#
# Identical logic previously hand-duplicated between
# netinit/script/netinit-entrypoint.sh and code-dind/script/dind-entrypoint.sh
# - see root CLAUDE.md's "netshare" section. Sourced, not exec'd; see
# wait-until.sh's own header comment for the vendoring note (netinit/ and
# code-dind/ build from a hand-synced copy, run vendor-netshare.sh after
# editing this file).
apply_default_route() {
    _adr_host="$1"
    _adr_gw="$(getent hosts "$_adr_host" 2>/dev/null | awk '{ print $1; exit }')"

    if [ -n "$_adr_gw" ]; then
        ip route replace default via "$_adr_gw" 2>/dev/null
    fi

    _adr_routes="$(ip -4 route show default 2>/dev/null)"
    _adr_count=$(printf '%s\n' "$_adr_routes" | grep -c '^default')
    _adr_unexpected=0
    if [ "$_adr_count" -gt 1 ]; then
        _adr_unexpected=1
    elif [ -n "$_adr_gw" ] && [ -n "$_adr_routes" ] && ! printf '%s\n' "$_adr_routes" | grep -q "via $_adr_gw"; then
        _adr_unexpected=1
    fi
    if [ "$_adr_unexpected" -eq 1 ]; then
        echo "apply_default_route: WARNING unexpected default route(s), expected only $_adr_host ($_adr_gw):" >&2
        printf '%s\n' "$_adr_routes" >&2
    fi

    [ -n "$_adr_gw" ]
}
