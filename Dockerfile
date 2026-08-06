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
# and repeatedly points its default route at router (formerly netgate),
# using the NET_ADMIN this tiny sidecar has but code-docker itself never
# gets (code-docker's own `ip` binary, from config/build.default.sh, is
# only ever used there for
# read-only route inspection - see the plan doc for the full "why not give
# code-docker NET_ADMIN itself" reasoning). Separate minimal stage so this
# capability lives in its own small image, not the `main` image below.
FROM alpine:latest AS netinit
RUN apk add --no-cache iproute2
COPY script/netinit-entrypoint.sh /netinit-entrypoint.sh
ENTRYPOINT ["/netinit-entrypoint.sh"]

# router (formerly the "netgate" stage) has moved out to its own subtree -
# see router/Dockerfile and functional-router-plan.md's "router 서브트리/
# 빌드 구조". docker-compose.yml's code-docker-router service now builds
# from router/ as its own context instead of a stage here.

# webmanager/frontend imports router/frontend as a real package
# (@code-docker/router-frontend, see .claude/backlog/functional-router-plan.md's
# "router ↔ webmanager 프론트 통합 방식") via an npm workspace rooted at the
# repo root (package.json's `workspaces:`) - so this stage needs the whole
# workspace, not just webmanager/frontend/ in isolation, or `npm ci` would
# try (and fail) to resolve that package from the public registry instead
# of linking it locally.
FROM node:24-alpine AS webmanager-frontend
WORKDIR /src
COPY package.json package-lock.json ./
COPY router/frontend/package.json router/frontend/package.json
COPY webmanager/frontend/package.json webmanager/frontend/package.json
RUN npm ci
COPY router/frontend/ router/frontend/
COPY webmanager/frontend/ webmanager/frontend/
RUN npm run build --workspace webmanager/frontend

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
COPY --from=webmanager-frontend /src/webmanager/frontend/dist /etc/code-docker/webmanager/static
COPY example-env.webmanager /etc/code-docker/webmanager/example-env.webmanager

# Log directories for per-program rotated log files (read by vector).
# tailscaled/tailscale-forward/tailscale-status/caddy-adapter moved to
# router (see .claude/backlog/functional-router-plan.md) - no longer
# programs in this image.
RUN mkdir -p /var/log/code /var/log/sshd /var/log/webmanager /var/log/nginx

# Copy config & static files
COPY --chown=root:root \
    config script/entrypoint.sh script/code-service.sh \
    script/user-init.sh script/get-user-shell.sh script/sshd-service.sh \
    script/webmanager.sh \
    script/vector-service.sh script/nginx-service.sh /etc/code-docker/
COPY --chown=root:root code-server-autoinstall/*.sh \
    /etc/code-docker/code-server-autoinstall/
COPY --chown=root:root bin /usr/local/bin/

# Setup user shell and home
RUN chsh root --shell $(/etc/code-docker/get-user-shell.sh) &&\
    sed -E 's|^(root:[^:]*:[^:]*:[^:]*:[^:]*:)/root(:[^:]*)$|\1/code\2|' -i /etc/passwd &&\
    mv /etc/ssh /etc/default

# Metadata
EXPOSE 22 80 81
STOPSIGNAL 15
ENTRYPOINT ["/etc/code-docker/entrypoint.sh"]
