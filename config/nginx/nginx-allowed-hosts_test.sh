#!/bin/bash
# Checks the always-allowed patterns in nginx-service.default.sh's ALLOWED_HOSTS
# map against hosts that must and must not pass. Run by dev-check.sh (every
# tracked *_test.sh); kept out of the image by .dockerignore.
#
# The patterns are read straight out of the script, so this tests what nginx
# actually gets. pcre2grep stands in for nginx's PCRE; nginx lowercases $host
# and strips the port before the map sees it, so the samples are written that way.
set -u
cd "$(dirname "$0")" || exit 1

mapfile -t patterns < <(sed -n "s/^ *\"~\(.*\)\" 1;'\?$/\1/p" nginx-service.default.sh)
if [ ${#patterns[@]} -lt 4 ]; then
    echo "found only ${#patterns[@]} map patterns in nginx-service.default.sh - did its layout change?" >&2
    exit 1
fi

allowed() {
    [ "$1" = localhost ] && return 0
    local p
    for p in "${patterns[@]}"; do
        printf '%s\n' "$1" | pcre2grep -q -- "$p" && return 0
    done
    return 1
}

failed=0
for host in localhost 127.0.0.1 192.168.0.10 '[::1]' '[::ffff:10.0.0.1]' \
    code-docker router foo.tail1234.ts.net; do
    allowed "$host" || { echo "should pass but is refused: $host"; failed=1; }
done
# Hex-only registrable names are the DNS-rebinding case the IP-literal
# patterns once let through.
for host in deadbeef.de c0ffee.cafe bad.ca a.be 1.2.3.4.de 1.2.3.4.5 abc.ts.net.evil.com \
    code.example.com '[::1].evil.com'; do
    allowed "$host" && { echo "should be refused but passes: $host"; failed=1; }
done
exit $failed
