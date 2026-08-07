# router - the network-boundary container for code-docker. Phase 2 of
# egress-netgate-plan.md's outbound lockdown started this as "netgate"
# (RFC1918/CIDR FORWARD filtering, inbound port-forwarding DNAT, a
# best-effort DNS-level content blocklist via dnsmasq); functional-router-plan.md is the
# vision doc that expands its role to also own tailscale (daemon+forwards+
# publish), the Dev Proxy Caddy instance, and a tinyauth forward-auth, while
# code-docker-netinit/dind's own routing loops keep pointing their default
# route at this container the same way they always have (see
# script/netinit-entrypoint.sh, script/dind-entrypoint.sh - both resolve the
# `router` alias, formerly `netgate`).
#
# Own subtree with its own Dockerfile/build context (router/) rather than a
# stage in the root Dockerfile - see functional-router-plan.md's "router
# 서브트리/빌드 구조" - so this container's growing feature set doesn't have
# to keep threading COPY paths back through the repo root, and so it reads
# as a genuinely separate, reusable component rather than one more stage
# among code-docker's own. It has meaningfully higher trust than code-docker
# (dind-authz's "네가 상대적으로 더 신뢰된 컨테이너다" framing applies here
# too), so its own packages/config shouldn't be reachable from inside
# code-docker at all.
#
# Built supervisord-based from the start (not a single monolithic
# entrypoint script) even though it only ran two programs originally, so
# tailscale/Dev-Proxy/tinyauth (see .claude/backlog/functional-router-plan.md)
# can each drop in their own [program:...] section without a rewrite - same
# idiom as the main image's own config/supervisord.default.conf, see root
# CLAUDE.md's "process model". config/supervisord.d/*.conf (this stage's own
# git-tracked built-in program definitions, one file per feature area) is
# what makes that possible - see config/netgate/supervisord.default.conf's
# own comment on the two include globs.
FROM golang:1.25-alpine AS router-manager-build
WORKDIR /src
COPY backend/go.mod ./
COPY backend/go.sum ./
COPY backend/main.go ./
COPY backend/hashpassword.go ./
COPY backend/envmigratecmd.go ./
COPY backend/handlers_auth.go ./
COPY backend/handlers_devproxy.go ./
COPY backend/handlers_tailscale.go ./
COPY backend/handlers_ui.go ./
COPY backend/internal ./internal
# router's build context is router/ only (see router/CLAUDE.md), so it can't
# COPY the repo-root envmigrate/ module directly the way webmanager's own
# Dockerfile stage does - backend/vendor/ (see script/vendor-envmigrate.sh)
# is a `go mod vendor`-materialized copy that lives inside this context
# instead. `go build` auto-detects and uses vendor/ when present/consistent.
COPY backend/vendor ./vendor
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /router-manager .

# Source for the tinyauth binary only (see config/tinyauth/tinyauth.default.sh)
# - tinyauth's own Dockerfile requires a mandatory pnpm frontend build ahead
# of its Go build, unlike router-manager-build above, so this extracts the
# already-built binary from upstream's official image instead of reproducing
# that build here.
FROM ghcr.io/tinyauthapp/tinyauth:v5 AS tinyauth-bin

FROM archlinux

# tailscale: the daemon+forwards+publish feature moved here from code-docker
# (see .claude/backlog/functional-router-plan.md's "tailscale 전체 이관").
# socat: tailscale-forward.default.sh's forwards implementation.
# caddy: Dev Proxy's internal instance (see
# router/config/caddy-adapter/caddy-adapter.default.sh, moved here from
# code-docker the same way).
# dnsmasq: DNS forwarder+cache for code-docker/dind, also doubling as the
# content blocklist enforcement point (see .claude/backlog/router-dns-plan.md's
# "2부" - replaces the squid intercept/SNI-block approach this container used
# to run, removed because squid's ssl-bump anti-spoofing check false-positives
# on CDN-style domains with rotating IP pools) - code-docker-internal being
# `internal: true` means Docker's own embedded DNS refuses to forward
# queries externally for anything attached to it, so code-docker/dind need
# a real resolver to point at instead.
# nginx: router's own front door (see
# router/.claude/router-nginx-hardening-plan.md) - terminates host:80
# directly now instead of the old DNAT-back-to-code-docker double hop.
RUN pacman -Suy --noconfirm --needed \
        iptables iproute2 supervisor yq gettext curl \
        tailscale socat caddy dnsmasq nginx && \
    pacman -Scc --noconfirm
RUN mkdir -p /var/log/netgate-firewall \
        /var/log/tailscaled /var/log/tailscale-forward /var/log/tailscale-publish \
        /var/log/router-manager /var/log/caddy-adapter /var/log/dns /var/log/nginx \
        /var/log/tinyauth \
        /etc/code-docker/netgate /etc/code-docker/dns /etc/code-docker/supervisord.d \
        /var/lib/code-docker-router
COPY --chown=root:root config/netgate /etc/code-docker/netgate
COPY --chown=root:root config/dns /etc/code-docker/dns
COPY --chown=root:root config/supervisord.d /etc/code-docker/supervisord.d
COPY --chown=root:root config/tailscale/tailscale-config.default.yaml \
    /etc/code-docker/tailscale-config.default.yaml
COPY --chown=root:root script/netgate-entrypoint.sh script/netgate-firewall.sh \
    script/tailscale-service.sh script/tailscale-forward.sh \
    script/tailscale-publish.sh script/caddy-adapter.sh script/dns.sh \
    script/nginx-service.sh script/tinyauth.sh /etc/code-docker/
COPY --chown=root:root config/tailscale/tailscale-service.default.sh \
    config/tailscale/tailscale-forward.default.sh \
    config/tailscale/tailscale-publish.default.sh \
    config/caddy-adapter/caddy-adapter.default.sh \
    config/nginx/nginx.default.conf config/nginx/nginx-service.default.sh \
    config/tinyauth/tinyauth.default.sh /etc/code-docker/
COPY --from=router-manager-build /router-manager /usr/local/bin/router-manager
COPY --from=tinyauth-bin /tinyauth/tinyauth /usr/local/bin/tinyauth
# `router-manager --env-migrate` and its startup version-mismatch check both
# read this (ROUTER_ENV_TEMPLATE_PATH, default matches this path) - see
# example-env.router's own doc comment and docs/router.md.
COPY --chown=root:root example-env.router /etc/code-docker/example-env.router
# Baked-in default blocklist (StevenBlack/hosts - a standard, generic list
# is sufficient per the plan doc, no prompt-injection-specific list
# needed), saved as-is: dnsmasq's addn-hosts= reads hosts-format files
# directly (see config/dns/dnsmasq.default.conf), so unlike the old squid
# era there's no dstdomain-list conversion step anymore. A
# config/dns/blocklist.override.hosts is checked for at runtime instead,
# added on top of this one (not swapped in for it) - see dns.default.sh.
RUN curl -fsSL -o /etc/code-docker/dns/blocklist.default.hosts \
        https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
ENTRYPOINT ["/etc/code-docker/netgate-entrypoint.sh"]
