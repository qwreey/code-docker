# code-dind - code-docker-dind's image, see docker-compose.yml's
# code-docker-dind service and script/dind-entrypoint.sh's own comments for
# why this wraps the stock docker:dind entrypoint.
#
# Own subtree with its own Dockerfile/build context (code-dind/) rather than
# a stage in the root Dockerfile - same reasoning as router/ (see
# router/CLAUDE.md and root CLAUDE.md's "router" section): this container's
# own build inputs (dind-authz Go module, its policy defaults) don't have to
# thread COPY paths back through the repo root, and it reads as a genuinely
# separate, reusable component. Named "code-dind" rather than "dind" -
# originally to dodge a collision with the DIND_VOLUME/DIND_AUTHZ_VOLUME
# runtime data directories that used to live at the repo root alongside it;
# those now default under a single repo-root `data/` folder (`./data/dind`,
# `./data/dind-authz`, see docker-compose.yml) specifically so no source
# subtree can ever collide with runtime data again - see code-dind/CLAUDE.md's
# "Naming" section.
FROM docker:dind AS dind
# iproute2: dind-entrypoint.sh's own interface-picking logic (see its
# comments below) plus the Phase 1 egress-netgate route loop it now also
# runs (root .claude/backlog/egress-netgate-plan.md) both need `ip`. tini:
# PID 1 init so that loop's forked `ip`/`getent` children get reaped once
# dockerd takes over as PID 1 - see dind-entrypoint.sh's own comment on this.
RUN apk add --no-cache iproute2 tini
# script/netshare/ is a hand-synced copy of the repo-root netshare/ module
# (see root CLAUDE.md's "netshare" section) - this subtree's own isolated
# build context can't COPY repo-root files directly. Run vendor-netshare.sh
# after editing netshare/, before rebuilding this image.
COPY script/netshare /netshare
COPY script/dind-entrypoint.sh /dind-entrypoint.sh
ENTRYPOINT ["/dind-entrypoint.sh"]

# dind-authz: an authorization plugin for the dockerd running inside dind
# (see script/dind-entrypoint.sh) that denies container-create requests
# asking for host-level privilege (Privileged, disallowed CapAdd,
# unconfined seccomp/apparmor, pid/net/ipc/cgroupns=host, device
# passthrough, or a bind-mount source outside /code) while allowing normal
# dev containers (redis, postgres, ...) through untouched. See
# .claude/dind-authz-plan.md for the full design rationale - a hand-written
# Go binary was chosen over OPA/opa-docker-authz to avoid an extra runtime
# and an untrusted binary fetch, matching this repo's existing pattern of
# building its own Go binaries (see webmanager-backend in the root
# Dockerfile).
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
# docker-compose.yml - deliberately NOT under /code, so code-docker itself
# can never edit the policy that constrains it) is merged on top at
# entrypoint time, not baked into the image.
COPY config/dind-authz/*.default.json /etc/dind-authz-defaults.d/

# dind-authz-remap: on top of dind-authz's request-level filtering, also
# remap nested-container UID 0 to an unprivileged host UID via Docker's
# userns-remap, so even a request that slips past dind-authz (a plugin bug,
# or the class of bug CVE-2026-34040 was) still can't become real host root
# - the daemon itself independently refuses --privileged once userns-remap
# is on. docker:dind already ships a deterministic "dockremap" user with a
# fixed /etc/subuid//etc/subgid range for exactly this purpose, so there's
# nothing to bake here beyond telling dockerd to use it (see
# dind-entrypoint.sh). NOT the default DIND_TARGET - LXC-hosted (and other
# nested-virtualization) Docker installs commonly apply their own UID
# remapping already, and stacking ours on top has a track record of
# storage-driver/permission issues on those hosts. See
# .claude/dind-authz-plan.md and root docs/tips/dind.md before opting in.
FROM dind-authz AS dind-authz-remap
ENV DIND_USERNS_REMAP=dockremap
