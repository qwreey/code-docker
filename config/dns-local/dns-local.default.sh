#!/bin/sh
set -u

# code-docker's side of the shared dns-local program. The resolver itself -
# and the whole writeup of the getaddrinfo ESERVFAIL bug it exists for -
# lives in qwreey/router-docker-client's own dns-local/, fetched at build
# time by this image's Dockerfile alongside netshare. It started here
# (2026-08-10) and moved out on 2026-08-27, when roblox-studio-docker turned
# out to have the identical bug in a worse form: only 127.0.0.11 in its
# resolv.conf, so no client class had external DNS at all and Roblox Studio
# failed at launch. Nothing about the fix was ever code-docker-specific, and
# code-docker-dind is the third known case (see
# .claude/backlog/dind-dns-servfail.md).
#
# What stays here is exactly what's local to this image: where netshare was
# installed, and the fact that NETGATE_ENABLED is code-docker's single
# documented "there is no router in this deployment" switch. Overriding any
# of this is still the usual dns-local.override.sh (see docs/index.md's
# customization section) - this file being a wrapper doesn't change that.

# NETGATE_ENABLED=false means the whole router boundary is behaviorally off,
# so there is nothing for the local resolver to forward to. DNS_LOCAL_ENABLED
# is the shared script's own switch and wins if it's set explicitly.
DNS_LOCAL_ENABLED="${DNS_LOCAL_ENABLED:-${NETGATE_ENABLED:-true}}"
export DNS_LOCAL_ENABLED

# Only used for a bounded, well-logged first wait on router's DNS forwarder;
# the shared script retries on its own if this isn't set.
NETSHARE_DIR="${NETSHARE_DIR:-/etc/code-docker/netshare}"
export NETSHARE_DIR

# Kept at code-docker's own historical path rather than the shared default,
# so nothing that looked for the pid file here has to move.
DNS_LOCAL_RUN_DIR="${DNS_LOCAL_RUN_DIR:-/run/code-docker}"
export DNS_LOCAL_RUN_DIR

exec /etc/code-docker/router-client/dns-local/dns-local.sh
