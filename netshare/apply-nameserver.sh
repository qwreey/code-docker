# apply_nameserver <router-hostname>
#
# Resolves <router-hostname> and writes /etc/resolv.conf with it as a
# second nameserver - 127.0.0.11 (Docker's own embedded resolver) stays
# first, since it's still what resolves local container names/aliases;
# router's dnsmasq is added as a fallback for names 127.0.0.11 won't/can't
# forward externally (code-docker-internal is `internal: true`, so Docker's
# embedded DNS refuses to forward externally on it - see
# router/.claude/router-dns-plan.md). Direct redirect (truncate-in-place),
# not tmp-file+mv - /etc/resolv.conf is a bind-mounted file in every
# consumer of this function, and `mv` onto a bind-mount target fails with
# "Resource busy". Only writes when the content would actually change, so
# callers can poll this cheaply in a tight loop. Returns 0 if the hostname
# resolved, 1 if it didn't (caller's loop just tries again next tick).
#
# Identical logic previously hand-duplicated between
# config/resolv-writer/resolv-writer.default.sh, script/entrypoint.sh, and
# code-dind/script/dind-entrypoint.sh - see root CLAUDE.md's "netshare"
# section. Sourced, not exec'd; see wait-until.sh's own header comment for
# the vendoring note (netinit/ and code-dind/ build from a hand-synced
# copy, run vendor-netshare.sh after editing this file).
apply_nameserver() {
    _ans_host="$1"
    _ans_ip="$(getent hosts "$_ans_host" 2>/dev/null | awk '{ print $1; exit }')"
    if [ -z "$_ans_ip" ]; then
        return 1
    fi
    if ! grep -q "^nameserver $_ans_ip\$" /etc/resolv.conf 2>/dev/null; then
        printf 'nameserver 127.0.0.11\nnameserver %s\noptions ndots:0\n' "$_ans_ip" > /etc/resolv.conf \
            && echo "apply_nameserver: /etc/resolv.conf now has $_ans_host ($_ans_ip) as fallback nameserver"
    fi
    return 0
}
