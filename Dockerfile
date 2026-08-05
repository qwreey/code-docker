FROM docker:latest AS docker-bin

# code-docker-dind's image - see docker-compose.yml's code-docker-dind service
# and dind-entrypoint.sh's own comments for why this wraps the stock
# docker:dind entrypoint. Built as a stage here (COPY at build time) rather
# than bind-mounted at runtime so it isn't tied to the compose file's
# location - see the "context:" comment on the main service below.
FROM docker:dind AS dind
# iproute2: dind-entrypoint.sh's own interface-picking logic (see its
# comments below) plus the Phase 1 egress-netgate route loop it now also
# runs (.claude/backlog/egress-netgate-plan.md) both need `ip`. tini: PID 1
# init so that loop's forked `ip`/`getent` children get reaped once dockerd
# takes over as PID 1 - see dind-entrypoint.sh's own comment on this.
RUN apk add --no-cache iproute2 tini
COPY script/dind-entrypoint.sh /dind-entrypoint.sh
ENTRYPOINT ["/dind-entrypoint.sh"]

# dind-authz: an authorization plugin for the dockerd running inside dind
# (see script/dind-entrypoint.sh) that denies container-create requests
# asking for host-level privilege (Privileged, disallowed CapAdd,
# unconfined seccomp/apparmor, pid/net/ipc/cgroupns=host, device
# passthrough, or a bind-mount source outside /code) while allowing normal
# dev containers (redis, postgres, ...) through untouched. See
# .claude/backlog/dind-authz-plan.md for the full design rationale — a
# hand-written Go binary was chosen over OPA/opa-docker-authz to avoid an
# extra runtime and an untrusted binary fetch, matching this repo's existing
# pattern of building its own Go binaries (see webmanager-backend below).
FROM golang:1.25-alpine AS dind-authz-build
WORKDIR /src
COPY dind-authz/go.mod ./
COPY dind-authz/*.go ./
RUN CGO_ENABLED=0 go test ./... && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /dind-authz .

FROM dind AS dind-authz
COPY --from=dind-authz-build /dind-authz /usr/local/bin/dind-authz
# Baked-in defaults (git-tracked). The live, host-editable conf.d directory
# (bind-mounted from DIND_AUTHZ_VOLUME at /etc/dind-authz.d, see
# docker-compose.yml — deliberately NOT under /code, so code-docker itself
# can never edit the policy that constrains it) is merged on top at
# entrypoint time, not baked into the image.
COPY config/dind-authz/*.default.json /etc/dind-authz-defaults.d/

# dind-authz-remap: on top of dind-authz's request-level filtering, also
# remap nested-container UID 0 to an unprivileged host UID via Docker's
# userns-remap, so even a request that slips past dind-authz (a plugin bug,
# or the class of bug CVE-2026-34040 was) still can't become real host root
# — the daemon itself independently refuses --privileged once userns-remap
# is on. docker:dind already ships a deterministic "dockremap" user with a
# fixed /etc/subuid//etc/subgid range for exactly this purpose, so there's
# nothing to bake here beyond telling dockerd to use it (see
# dind-entrypoint.sh). NOT the default DIND_TARGET — LXC-hosted (and other
# nested-virtualization) Docker installs commonly apply their own UID
# remapping already, and stacking ours on top has a track record of
# storage-driver/permission issues on those hosts. See
# .claude/backlog/dind-authz-plan.md and docs/tips/dind.md before opting in.
FROM dind-authz AS dind-authz-remap
ENV DIND_USERNS_REMAP=dockremap

# netinit - Phase 1 of egress-netgate-plan.md's outbound lockdown. Shares
# code-docker's network namespace at runtime (docker-compose.yml's
# `network_mode: service:code-docker` on the code-docker-netinit service)
# and repeatedly points its default route at netgate, using the NET_ADMIN
# this tiny sidecar has but code-docker itself never gets (code-docker's own
# `ip` binary, from config/build.default.sh, is only ever used there for
# read-only route inspection - see the plan doc for the full "why not give
# code-docker NET_ADMIN itself" reasoning). Separate minimal stage so this
# capability lives in its own small image, not the `main` image below.
FROM alpine:latest AS netinit
RUN apk add --no-cache iproute2
COPY script/netinit-entrypoint.sh /netinit-entrypoint.sh
ENTRYPOINT ["/netinit-entrypoint.sh"]

# netgate - Phase 2 of egress-netgate-plan.md's outbound lockdown. The
# chokepoint code-docker-netinit/dind's own routing loops (above) point
# their default route at: RFC1918/CIDR FORWARD filtering, inbound
# port-forwarding (DNAT), and a best-effort squid content blocklist. Built
# supervisord-based from the start (not a single monolithic entrypoint
# script) even though it only runs two programs today, so a future "router"
# feature (tailscale/Caddy/tinyauth - see
# .claude/backlog/functional-router-plan.md, out of scope for now) can drop
# in more [program:...] sections without a rewrite - same idiom as the main
# image's own config/supervisord.default.conf, see CLAUDE.md's "process
# model". Separate minimal stage, not part of the `main` image below - it
# has meaningfully higher trust than code-docker (dind-authz's "네가
# 상대적으로 더 신뢰된 컨테이너다" framing applies here too), so its own
# packages/config shouldn't be reachable from inside code-docker at all.
FROM archlinux AS netgate
RUN pacman -Suy --noconfirm --needed \
        iptables iproute2 squid supervisor yq gettext curl openssl && \
    pacman -Scc --noconfirm
RUN mkdir -p /var/log/netgate-firewall /var/log/squid /var/cache/squid /etc/code-docker/netgate && \
    chown -R proxy:proxy /var/cache/squid
COPY --chown=root:root config/netgate /etc/code-docker/netgate
COPY --chown=root:root script/netgate-entrypoint.sh script/netgate-firewall.sh \
    script/netgate-squid.sh script/netgate-blocklist.sh /etc/code-docker/
# ssl-bump's https_port directive requires SOME cert configured at
# parse-time even though this config only ever peeks the SNI and
# splices/terminates (see squid.default.conf's own comment) - never
# actually bumps/decrypts a connection, so a throwaway self-signed cert
# generated once at build time is fine; it is never presented to a client.
RUN openssl req -new -newkey rsa:2048 -sha256 -days 3650 -nodes -x509 \
        -subj "/CN=code-docker-netgate" \
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

FROM node:24-alpine AS webmanager-frontend
WORKDIR /src
COPY webmanager/frontend/package.json webmanager/frontend/package-lock.json ./
RUN npm ci
COPY webmanager/frontend/ ./
RUN npm run build

FROM golang:1.25-alpine AS webmanager-backend
WORKDIR /src
COPY webmanager/backend/go.mod webmanager/backend/go.sum ./
RUN go mod download
COPY webmanager/backend/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /webmanager .

FROM archlinux AS main

# Init makepkg user and install yay
COPY --chown=root:root script/install-yay.sh /etc/code-docker/
RUN --mount=type=cache,target=/home/makepkg \
    --mount=type=cache,target=/var/yay-bin \
    --mount=type=cache,target=/var/cache/pacman \
    /etc/code-docker/install-yay.sh

# Run build script
COPY --chown=root:root script/build.sh config/build.* /etc/code-docker/
RUN --mount=type=cache,target=/var/cache/pacman /etc/code-docker/build.sh

# Copy dind docker cli
COPY --from=docker-bin /usr/local/bin/docker /usr/bin/docker

# Copy webmanager binary + prebuilt frontend assets + its example-env.webmanager
# template (read by `webmanager --env-migrate`/the startup version check via
# WEBMANAGER_ENV_TEMPLATE_PATH — not go:embed, so an operator running
# multiple instances can bind-mount their own over this path instead, see
# webmanager/.claude/env-migration-plan.md).
COPY --from=webmanager-backend /webmanager /etc/code-docker/webmanager/webmanager
COPY --from=webmanager-frontend /src/dist /etc/code-docker/webmanager/static
COPY example-env.webmanager /etc/code-docker/webmanager/example-env.webmanager

# Log directories for per-program rotated log files (read by vector)
RUN mkdir -p /var/log/code /var/log/sshd /var/log/tailscaled \
    /var/log/tailscale-forward /var/log/tailscale-status /var/log/webmanager \
    /var/log/nginx /var/log/caddy-adapter

# Copy config & static files
COPY --chown=root:root \
    config script/entrypoint.sh script/code-service.sh \
    script/user-init.sh script/get-user-shell.sh script/sshd-service.sh \
    script/tailscale-service.sh script/tailscale-forward.sh \
    script/tailscale-status.sh script/webmanager.sh \
    script/vector-service.sh script/nginx-service.sh \
    script/caddy-adapter.sh /etc/code-docker/
COPY --chown=root:root code-server-autoinstall/*.sh \
    /etc/code-docker/code-server-autoinstall/
COPY --chown=root:root bin /usr/local/bin/

# Setup user shell and home
RUN chsh root --shell $(/etc/code-docker/get-user-shell.sh) &&\
    sed -E 's|^(root:[^:]*:[^:]*:[^:]*:[^:]*:)/root(:[^:]*)$|\1/code\2|' -i /etc/passwd &&\
    mv /etc/ssh /etc/default

# Metadata
EXPOSE 22 80 81 8082
STOPSIGNAL 15
ENTRYPOINT ["/etc/code-docker/entrypoint.sh"]
