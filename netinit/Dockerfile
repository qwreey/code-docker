# netinit - Phase 1 of egress-netgate-plan.md's outbound lockdown. Shares
# code-docker's network namespace at runtime (docker-compose.yml's
# `network_mode: service:code-docker` on the code-docker-netinit service)
# and repeatedly points its default route at router (formerly netgate),
# using the NET_ADMIN this tiny sidecar has but code-docker itself never
# gets (code-docker's own `ip` binary, from config/build.default.sh, is only
# ever used there for read-only route inspection - see root
# .claude/backlog/egress-netgate-plan.md for the full "why not give
# code-docker NET_ADMIN itself" reasoning).
#
# Own subtree (own Dockerfile/build context) rather than a stage in the root
# Dockerfile, same reasoning as code-dind/ and router/ - this loop's job
# (default-route enforcement for a `network_mode: service:X` sidecar) isn't
# actually specific to code-docker, so keeping it a self-contained image
# rather than a stage buried in code-docker's own Dockerfile makes it usable
# by a future sidecar the same way, without threading COPY paths through the
# repo root.
FROM alpine:latest
RUN apk add --no-cache iproute2
COPY script/netinit-entrypoint.sh /netinit-entrypoint.sh
ENTRYPOINT ["/netinit-entrypoint.sh"]
