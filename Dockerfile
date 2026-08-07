FROM docker:latest AS docker-bin

# code-docker-dind (code-dind/Dockerfile) and code-docker-netinit
# (netinit/Dockerfile) have moved out to their own subtrees, same pattern as
# router/ - see root CLAUDE.md's "docker-compose topology"/"router" sections
# and code-dind/CLAUDE.md / netinit/CLAUDE.md. docker-compose.yml's
# code-docker-dind/code-docker-netinit services now build from those
# directories as their own contexts instead of a stage here.

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
# WORKDIR mirrors the real repo's relative layout (not just /src) so
# webmanager/backend/go.mod's `replace code-docker/envmigrate =>
# ../../envmigrate` resolves the same way here as it does on a developer's
# own checkout - see envmigrate/'s own doc comment for why this package is
# a repo-root module shared with router/backend instead of living under
# webmanager/backend/internal.
WORKDIR /src/webmanager/backend
COPY envmigrate/ /src/envmigrate/
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
# programs in this image. resolv-writer is new - see
# .claude/backlog/router-dns-plan.md.
RUN mkdir -p /var/log/code /var/log/sshd /var/log/webmanager /var/log/nginx \
    /var/log/resolv-writer

# Copy config & static files
COPY --chown=root:root \
    config script/entrypoint.sh script/code-service.sh \
    script/user-init.sh script/get-user-shell.sh script/sshd-service.sh \
    script/webmanager.sh script/resolv-writer.sh \
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
