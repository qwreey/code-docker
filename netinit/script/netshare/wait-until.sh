# wait_until <description> <timeout-seconds> <interval-seconds> <test-command...>
#
# Generic poll-until-timeout helper, meant to be sourced (`.`, not exec'd)
# into a script that has its own `set -e`/trap conventions - see root
# CLAUDE.md's "netshare" section for why this exists (dedupes the
# hand-rolled retry loop previously copy-pasted across
# script/entrypoint.sh, netinit/script/netinit-entrypoint.sh, and
# code-dind/script/dind-entrypoint.sh).
#
# Polls <test-command> every <interval>s until it exits 0, up to <timeout>s
# total. Returns 0 once it succeeds, 1 on timeout - never exits the calling
# script itself, so callers decide what a timeout means (fatal vs
# best-effort).
#
# code-docker itself gets this file via a direct Dockerfile COPY (same
# build context). netinit/ and code-dind/ each have their own isolated
# Dockerfile build context and can't reach repo-root netshare/ directly, so
# they build from a hand-synced copy under their own script/netshare/ -
# run vendor-netshare.sh after editing this file, before rebuilding either
# of those images.
wait_until() {
    _wu_desc="$1"; _wu_timeout="$2"; _wu_interval="$3"; shift 3
    _wu_waited=0
    echo "wait_until: waiting for $_wu_desc..."
    while ! "$@" >/dev/null 2>&1; do
        _wu_waited=$((_wu_waited + _wu_interval))
        if [ "$_wu_waited" -ge "$_wu_timeout" ]; then
            echo >&2 "wait_until: timed out after ${_wu_timeout}s waiting for $_wu_desc"
            return 1
        fi
        sleep "$_wu_interval"
    done
    echo "wait_until: $_wu_desc ready"
    return 0
}
