FROM docker:latest AS docker-bin

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

# Copy webmanager binary + prebuilt frontend assets
COPY --from=webmanager-backend /webmanager /etc/code-docker/webmanager/webmanager
COPY --from=webmanager-frontend /src/dist /etc/code-docker/webmanager/static

# Log directories for per-program rotated log files (read by vector)
RUN mkdir -p /var/log/code-server /var/log/sshd /var/log/tailscaled \
    /var/log/tailscale-forward /var/log/tailscale-status /var/log/webmanager

# Copy config & static files
COPY --chown=root:root \
    config script/entrypoint.sh script/code-service.sh \
    script/get-user-shell.sh script/sshd-service.sh \
    script/tailscale-service.sh script/tailscale-forward.sh \
    script/tailscale-status.sh script/webmanager.sh \
    script/vector-service.sh /etc/code-docker/
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
