# netinit

Scoped guidance for anyone (human or agent) working under `netinit/`. This
is the build source for the `code-docker-netinit` service
(docker-compose.yml) - a tiny sidecar that shares code-docker's network
namespace (`network_mode: service:code-docker`) and repeatedly points its
default route at `router`, using the `NET_ADMIN` capability code-docker
itself deliberately never gets. See root `CLAUDE.md`'s "router" section
(the "netgate (egress lockdown)" bullet) and
`.claude/backlog/egress-netgate-plan.md` for the full design/rationale -
don't re-derive decisions already recorded there.

## What's here

- `Dockerfile` - a minimal `alpine` image with `iproute2`, entrypoint set to
  `script/netinit-entrypoint.sh`.
- `script/netinit-entrypoint.sh` - the loop itself: resolves `ROUTER_HOSTNAME`
  (default `router`) every 5s and applies the default route to it via
  `apply_default_route` (see below), defensively (never exits non-zero on
  `router` not resolving - see the script's own comments for why, and for
  the "netns got recreated out from under us" exit-and-let-`restart:`-recreate
  case).
- `script/netshare/` - a hand-synced copy of the repo-root `netshare/`
  module (see root `CLAUDE.md`'s "netshare" section) - this subtree's own
  isolated Dockerfile build context can't `COPY` repo-root files directly.
  Run `vendor-netshare.sh` (repo root) after editing anything under
  `netshare/`, before rebuilding this image - don't hand-edit
  `script/netshare/*.sh` directly, it'll just get overwritten next sync.

## Why this is its own subtree

Split out from a stage in the root Dockerfile for the same reason
`router/` and `code-dind/` are their own subtrees: this loop's actual job
(default-route enforcement for a `network_mode: service:X` sidecar) isn't
conceptually tied to code-docker specifically - keeping it a self-contained
image rather than one more stage in code-docker's own Dockerfile means a
future sidecar wanting the same pattern can point `docker-compose.yml`'s
`build.context` at this directory too, instead of the logic being copy-pasted
or threaded back through the repo root. `code-docker-dind` doesn't use this
image - it's `privileged: true` already, so `code-dind/script/dind-entrypoint.sh`
runs an equivalent loop directly against its own netns instead of needing a
separate sidecar.

Note the env var names (`NETGATE_ENABLED`, `ROUTER_HOSTNAME`) still reflect
this loop's origin as part of code-docker's own egress lockdown, not a
fully generic sidecar contract - a future second consumer would currently
just reuse the same two env vars rather than this being parameterized
per-service.

## Ground rules

- Follow the root `CLAUDE.md`'s override pattern and code style (minimal
  comments, no premature abstraction) for anything touching outside
  `netinit/` (docker-compose.yml, etc).
- Before running `docker compose build`/`up`/`restart` against a live
  container, confirm it's actually safe - someone else may be iterating on
  it.
