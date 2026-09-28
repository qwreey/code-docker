# qwreey/router-docker-client subdirectories, fetched at build time (floating #main
# ref, see that repo's own CLAUDE.md). Each is its own stage so a BuildKit named context
# of the same name replaces it - docker-compose.yml's build.additional_contexts does
# that from ROUTER_CLIENT_SOURCE, to build against a local dev/ checkout. A plain ADD
# of a local path couldn't: it would have to sit inside this build context, and dev/
# is .dockerignore'd on purpose. A bare `docker build .` gets these defaults.
FROM scratch AS netshare
ADD https://github.com/qwreey/router-docker-client.git#main:netshare /
FROM scratch AS dns-local
ADD https://github.com/qwreey/router-docker-client.git#main:dns-local /
# code-server-autoinstall, same mechanism but pinned to a release tag rather than
# floating: it installs and patches code-server itself, so an unreviewed upstream
# commit breaking it means a container that doesn't come up. docker-compose.yml passes
# AUTOINSTALL_REF (and AUTOINSTALL_SOURCE for a local dev/ checkout) - keep this
# default equal to the one there.
FROM scratch AS code-server-autoinstall
ARG AUTOINSTALL_REF=v0.1.1
ADD https://github.com/qwreey/code-server-autoinstall.git#${AUTOINSTALL_REF} /

FROM docker:latest AS docker-bin

# code-docker-dind (dind-authz-docker's own Dockerfile) and router-docker are their
# own standalone repos, not local directories - see root CLAUDE.md's
# "docker-compose topology" section and dind-authz-docker's own CLAUDE.md.
# code-docker-netinit-docker builds directly from qwreey/router-docker-client's own
# repo (see docker-compose.yml's build.context for that service), and
# code-docker-dind builds from qwreey/dind-authz-docker as a remote build context by
# default too (DIND_CONTEXT overrides it to a local dev/dind-authz-docker checkout).

# router's tabs are embedded as an iframe into its own /router/ page
# (components/RouterEmbed/RouterFrame.tsx) rather than rendered as same-origin React
# components, so webmanager/frontend no longer imports @code-docker/router-frontend
# (see .claude/archive/router-frontend-decouple-plan-done.md) - the couple of
# generic UI primitives (ErrorBanner/Sheet/Skeleton) it used are hand-copied into
# webmanager/frontend/src/components/common/ instead. This stage still runs from the
# repo-root npm workspace (root package.json's `workspaces:` lists both frontends),
# but no longer COPYs router-docker's frontend/ - webmanager/frontend builds
# standalone.
FROM node:24-alpine AS webmanager-frontend
WORKDIR /src
COPY package.json package-lock.json ./
COPY webmanager/frontend/package.json webmanager/frontend/package.json
RUN npm ci
COPY webmanager/frontend/ webmanager/frontend/
RUN npm run build --workspace webmanager/frontend

FROM golang:1.25-alpine AS webmanager-backend
# github.com/qwreey/envmigrate (shared with router-docker) is an ordinary tagged
# module now, downloaded by `go mod download` like any other dependency - it used
# to be a repo-root submodule wired in with a `replace` directive.
WORKDIR /src/webmanager/backend
COPY webmanager/backend/go.mod webmanager/backend/go.sum ./
RUN go mod download
COPY webmanager/backend/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /webmanager .

# code-docker's built-in webmanager extension for code-server
# (webmanager/vscode-extension/, plain JS - no build step beyond packaging).
# The stamp is a hash of the extension's source files, so it changes exactly
# when the extension does, whatever the layer cache did; code-extensions.
# default.sh compares it on every start to keep the installed copy in sync
# with this image (installing, upgrading or downgrading as needed).
FROM node:24-alpine AS code-extension
RUN npm install -g @vscode/vsce@3
WORKDIR /src
COPY webmanager/vscode-extension/ ./
RUN STAMP="$(find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)" \
 && VER="$(node -p 'require("./package.json").version')" \
 && printf '{"build":"%s"}\n' "$STAMP" > build.json \
 && mkdir /out \
 && vsce package --no-dependencies --skip-license --allow-missing-repository -o /out/code-docker-webmanager.vsix \
 && printf '%s %s\n' "$VER" "$STAMP" > /out/code-docker-webmanager.stamp

FROM archlinux AS main

# Init makepkg user and install yay
COPY --chown=root:root script/install-yay.sh /etc/code-docker/
RUN --mount=type=cache,target=/home/makepkg \
    --mount=type=cache,target=/var/yay-bin \
    --mount=type=cache,target=/var/cache/pacman \
    /etc/code-docker/install-yay.sh

# Run build script
COPY --chown=root:root script/override /etc/code-docker/
COPY --chown=root:root config/build /etc/code-docker/build
RUN --mount=type=cache,target=/var/cache/pacman /etc/code-docker/override exec build/build.default.sh

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
COPY --from=code-extension /out/ /etc/code-docker/code/extensions/

# Log directories for per-program rotated log files (read by vector).
# tailscaled/tailscale-forward/tailscale-status/caddy-adapter are router's
# programs, not this image's (see dev/router-docker/.claude/functional-router-plan.md
# locally). dns-local replaced the old resolv-writer program - see
# .claude/archive/dns-local-servfail-fix-done.md.
RUN mkdir -p /var/log/code /var/log/sshd /var/log/webmanager /var/log/nginx \
    /var/log/dns-local

# /etc/code-docker/supervisord/ is where a user's own gitignored
# config/supervisord/*.conf override files land (see CLAUDE.md's "process
# model") - no placeholder is checked into git for it (config/ is reorganized
# into per-program folders now, see config/supervisord.d/ for the built-in
# ones), so create it directly instead.
RUN mkdir -p /etc/code-docker/supervisord

# Copy config & static files
# netshare/dns-local: see the stages at the top of this file.
COPY --from=netshare --chown=root:root . /etc/code-docker/netshare
# dns-local lives in router-docker-client too (never code-docker-specific -
# roblox-studio-docker hit the identical bug); config/dns-local/dns-local.default.sh
# is just the thin wrapper supplying this image's own paths/defaults. Installed
# beside netshare rather than into /etc/code-docker/dns-local/, which is where the
# COPY below puts config/dns-local/'s own git-tracked files.
COPY --from=dns-local --chown=root:root . /etc/code-docker/router-client/dns-local
COPY --chown=root:root \
    config script/entrypoint.sh /etc/code-docker/
COPY --from=code-server-autoinstall --chown=root:root /*.sh \
    /etc/code-docker/code-server-autoinstall/
COPY --chown=root:root bin /usr/local/bin/

# One symlink per git hook name into config/git/hooks/, all pointing at the
# single hook-dispatch entry point (see that script for what it does with
# them). Generated here rather than checked into git so the list is one
# readable line instead of ~25 symlink blobs in the tree.
#
# Every name, not just the hooks this image implements: a global
# core.hooksPath REPLACES a repository's own .git/hooks/ for ALL hooks, so a
# directory holding only prepare-commit-msg would silently disable husky,
# pre-commit, lefthook and every hand-written hook in every project in the
# container. hook-dispatch chains through to the repository's own hook.
RUN cd /etc/code-docker/git/hooks && \
    for h in applypatch-msg pre-applypatch post-applypatch pre-commit \
             pre-merge-commit prepare-commit-msg commit-msg post-commit \
             pre-rebase post-checkout post-merge pre-push pre-receive update \
             proc-receive post-receive post-update reference-transaction \
             push-to-checkout pre-auto-gc post-rewrite sendemail-validate \
             post-index-change; do \
        ln -sf hook-dispatch "$h"; \
    done && \
    chmod +x hook-dispatch ai-trailer.sh ./*.default.sh

# fish completion for `attach` (see config/shell/completions/attach.fish) -
# /etc/fish/completions is fish's own system-wide completion path, so this
# is picked up for root or any other user with no per-user setup needed.
COPY --chown=root:root config/shell/completions/attach.fish /etc/fish/completions/attach.fish

# Setup user shell and home
RUN chsh root --shell "$(cat "$(/etc/code-docker/override path shell/shell.default)")" &&\
    sed -E 's|^(root:[^:]*:[^:]*:[^:]*:[^:]*:)/root(:[^:]*)$|\1/code\2|' -i /etc/passwd &&\
    mv /etc/ssh /etc/default

# Metadata
EXPOSE 22 80 81
STOPSIGNAL 15
ENTRYPOINT ["/etc/code-docker/entrypoint.sh"]
