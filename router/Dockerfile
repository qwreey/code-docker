# router - the network-boundary container for code-docker. Phase 2 of
# egress-netgate-plan.md's outbound lockdown started this as "netgate"
# (RFC1918/CIDR FORWARD filtering, inbound port-forwarding DNAT, a
# best-effort squid content blocklist); functional-router-plan.md is the
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
COPY backend/main.go ./
COPY backend/handlers_devproxy.go ./
COPY backend/internal ./internal
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /router-manager .

FROM archlinux

# tailscale: the daemon+forwards+publish feature moved here from code-docker
# (see .claude/backlog/functional-router-plan.md's "tailscale 전체 이관").
# socat: tailscale-forward.default.sh's forwards implementation.
# caddy: Dev Proxy's internal instance (see
# router/config/caddy-adapter/caddy-adapter.default.sh, moved here from
# code-docker the same way).
RUN pacman -Suy --noconfirm --needed \
        iptables iproute2 squid supervisor yq gettext curl openssl \
        tailscale socat caddy && \
    pacman -Scc --noconfirm
RUN mkdir -p /var/log/netgate-firewall /var/log/squid /var/cache/squid \
        /var/log/tailscaled /var/log/tailscale-forward /var/log/tailscale-publish \
        /var/log/router-manager /var/log/caddy-adapter \
        /etc/code-docker/netgate /etc/code-docker/supervisord.d \
        /var/lib/code-docker-router && \
    chown -R proxy:proxy /var/cache/squid
COPY --chown=root:root config/netgate /etc/code-docker/netgate
COPY --chown=root:root config/supervisord.d /etc/code-docker/supervisord.d
COPY --chown=root:root config/tailscale/tailscale-config.default.yaml \
    /etc/code-docker/tailscale-config.default.yaml
COPY --chown=root:root script/netgate-entrypoint.sh script/netgate-firewall.sh \
    script/netgate-squid.sh script/netgate-blocklist.sh \
    script/tailscale-service.sh script/tailscale-forward.sh \
    script/tailscale-publish.sh script/caddy-adapter.sh /etc/code-docker/
COPY --chown=root:root config/tailscale/tailscale-service.default.sh \
    config/tailscale/tailscale-forward.default.sh \
    config/tailscale/tailscale-publish.default.sh \
    config/caddy-adapter/caddy-adapter.default.sh /etc/code-docker/
COPY --from=router-manager-build /router-manager /usr/local/bin/router-manager
# ssl-bump's https_port directive requires SOME cert configured at
# parse-time even though this config only ever peeks the SNI and
# splices/terminates (see squid.default.conf's own comment) - never
# actually bumps/decrypts a connection, so a throwaway self-signed cert
# generated once at build time is fine; it is never presented to a client.
RUN openssl req -new -newkey rsa:2048 -sha256 -days 3650 -nodes -x509 \
        -subj "/CN=code-docker-router" \
        -keyout /tmp/netgate-ca.key -out /tmp/netgate-ca.crt && \
    mkdir -p /etc/squid/ssl && \
    cat /tmp/netgate-ca.crt /tmp/netgate-ca.key > /etc/squid/ssl/netgate-ca.pem && \
    rm -f /tmp/netgate-ca.key /tmp/netgate-ca.crt && \
    chown -R proxy:proxy /etc/squid/ssl
# Squid's ssl-bump support unconditionally starts sslcrtd_program helpers
# for any https_port using ssl-bump (even though generate-host-certificates
# is never turned on here, since peek+splice/terminate never actually
# generates a cert) - it refuses to run at all if this on-disk cert-cache
# database doesn't exist yet, so it has to be initialized once regardless
# of whether it's ever actually used.
RUN /usr/lib/squid/security_file_certgen -c -s /var/cache/squid/ssl_db -M 4MB && \
    chown -R proxy:proxy /var/cache/squid/ssl_db
# Baked-in default blocklist (StevenBlack/hosts - a standard, generic list
# is sufficient per the plan doc, no prompt-injection-specific list
# needed). config/netgate/blocklist.override.acl (already in dstdomain-list
# format - see netgate-blocklist.sh if you're converting your own
# hosts-format source) is checked for at runtime instead, same override
# pattern as everything else here - see squid.default.sh.
RUN curl -fsSL -o /tmp/netgate-hosts-src https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts && \
    /etc/code-docker/netgate-blocklist.sh /tmp/netgate-hosts-src /etc/code-docker/netgate/blocklist.default.acl && \
    rm -f /tmp/netgate-hosts-src
ENTRYPOINT ["/etc/code-docker/netgate-entrypoint.sh"]
