#!/bin/sh
set -eu

# Converts a hosts-format blocklist (StevenBlack/hosts-style
# "0.0.0.0 evil.com" lines, or "127.0.0.1 evil.com") into one bare domain
# per line, suitable for squid's `acl blocklist dstdomain "<file>"` (see
# config/netgate/squid.default.conf). Used both at build time (Dockerfile,
# to bake the default from StevenBlack/hosts) and available in the image
# for anyone assembling their own config/netgate/blocklist.override.acl
# from a different hosts-format source before building.

if [ "$#" -ne 2 ]; then
	echo >&2 "usage: netgate-blocklist.sh <input-hosts-file> <output-acl-file>"
	exit 1
fi
in="$1"
out="$2"

grep -E '^(0\.0\.0\.0|127\.0\.0\.1)[[:space:]]' "$in" |
	awk '{ print $2 }' |
	grep -vE '^(0\.0\.0\.0|localhost|localhost\.localdomain|local|broadcasthost|ip6-[a-z]+)$' |
	tr 'A-Z' 'a-z' |
	sort -u >"$out"
