# code-dind

Scoped guidance for anyone (human or agent) working under `code-dind/`. This
is the build source for the `code-docker-dind` service (docker-compose.yml)
- the privileged Docker-in-Docker daemon code-docker talks to via
`DOCKER_HOST=tcp://dind:2375` to run `docker`/`docker compose`/`docker
buildx` from inside code-docker. See root `CLAUDE.md`'s "docker-compose
topology" section for how this fits into the wider network/trust model, and
`.claude/dind-authz-plan.md` for the full design history/rationale behind
the authz plugin and userns-remap layering below - don't re-derive decisions
already recorded there.

## What's here

- `Dockerfile` - three build-target stages layered on top of stock
  `docker:dind`: `dind` (no protection), `dind-authz` (default - denies
  privileged/dangerous-cap/host-namespace/out-of-`/code`-mount container
  creation via a hand-written Go authz plugin), `dind-authz-remap`
  (`dind-authz` + Docker userns-remap, opt-in). `docker-compose.yml`'s
  `DIND_TARGET` env var picks which stage `code-docker-dind` actually
  builds/runs - a build-stage choice rather than a runtime toggle so an
  unwanted stage's code/config isn't even present in the image.
- `script/dind-entrypoint.sh` - the custom entrypoint (replaces
  `docker:dind`'s own) that binds the daemon to `code-docker-internal` only
  (never `0.0.0.0`), self-detects which of the stages above it's running on
  (starts the authz plugin / passes `--userns-remap` only if that stage's
  artifacts are present), and applies the same default-route-enforcement +
  nameserver-writing `netinit/` uses for code-docker's routing (code-docker's
  own DNS resolution moved to a local dnsmasq under `config/dns-local/`
  instead - see root `CLAUDE.md`'s `.claude/backlog/dns-local-servfail-fix.md`
  for why dind still uses the plain `apply_nameserver` approach this
  paragraph describes), against dind's own netns instead (dind already has
  `NET_ADMIN` via
  `privileged: true`, so it doesn't need a separate sidecar the way
  code-docker does) - via `apply_default_route`/`apply_nameserver`, applied
  once synchronously before `dockerd` starts (so nested containers get
  correct DNS baked in from their very first `docker run`, not just once
  the background loop's first tick lands) and then kept current by a
  background loop, same shape as before.
- `netshare` functions (`apply_default_route`/`apply_nameserver`) come from
  [qwreey/router-docker-client](https://github.com/qwreey/router-docker-client)'s
  `netshare/` subdirectory, fetched directly into the image via the
  Dockerfile's own `ADD https://github.com/qwreey/router-docker-client.git#main:netshare /netshare`
  (floating `#main` ref, not a local checkout/submodule) - see that repo's
  own `CLAUDE.md` for why.
- `dind-authz/` - the authz plugin's Go source (own `go.mod`, standalone
  module, `go test ./...` runs directly from here).
- `config/dind-authz/*.default.json` - baked-in allow-list defaults for the
  authz plugin, merged at container-start with the live, host-editable
  `DIND_AUTHZ_VOLUME` mount (`/etc/dind-authz.d`) - deliberately never
  mounted into code-docker itself by any path, see `.claude/dind-authz-plan.md`'s
  "볼륨 격리" section for why.

## Naming

This directory is named `code-dind`, not `dind`, originally so it couldn't
collide with the repo-root runtime data directories Docker writes to - before
this subtree existed, the *source* for the authz plugin lived at repo-root
`./dind-authz/`, the exact same path the runtime volume defaulted to, a real
collision. Every runtime data directory has since moved under a single
repo-root `data/` folder (`DIND_VOLUME`/`DIND_AUTHZ_VOLUME` now default to
`./data/dind`/`./data/dind-authz`, see docker-compose.yml and root
CLAUDE.md's "docker-compose topology") specifically so source subtrees
(`code-dind/`, `router/`, ...) and runtime data never share a naming
namespace at all - the original collision this section describes can't
recur regardless of what any subtree is named now, but the name stuck.

## Ground rules

- Follow the root `CLAUDE.md`'s override pattern and code style (minimal
  comments, no premature abstraction) for anything touching outside
  `code-dind/` (docker-compose.yml, etc).
- This container is meaningfully more trusted than code-docker (it's
  `privileged: true` and can create host-kernel-equivalent containers) -
  changes here should be held to that higher trust bar, same framing
  `router/CLAUDE.md` uses for router.
- Before running `docker compose build`/`up`/`restart` against a live
  container, confirm it's actually safe - someone else may be iterating on
  it.
