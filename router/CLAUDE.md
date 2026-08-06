# router

Scoped guidance for anyone (human or agent) working under `router/`. Read
`plan.md` first — it's kept short (current status + a linked TODO only).
This subtree follows the same convention as `webmanager/` (see that
subtree's own `CLAUDE.md` for the fully-grown example): `router/CLAUDE.md` +
`router/plan.md` at the subtree root, feature-specific design/history docs
(once they exist) under `router/.claude/`.

## What this is

The network-boundary container for code-docker — see
`.claude/backlog/functional-router-plan.md` (repo root) for the full vision
and every design decision, and `.claude/backlog/egress-netgate-plan.md`
(repo root) for the egress/DNAT design this container started from (it was
`code-docker-netgate` before being promoted to this subtree). Don't
re-derive decisions already recorded there.

## Current state

Only the original netgate functionality (outbound CIDR filtering via
iptables, squid content blocklist, inbound DNAT) lives here so far, moved
from `config/netgate/`/`script/netgate-*.sh` at the repo root with no
behavior change — see `router/config/netgate/` and `router/script/`. The
`netgate` name is kept as this feature area's own namespace inside the
container; the container/service itself is `router`/`code-docker-router`.

tailscale, Dev Proxy (Caddy), and tinyauth have not moved in yet — see
`plan.md`'s TODO list.

## Ground rules

- Follow the root `CLAUDE.md`'s override pattern (`<name>.default.*` +
  gitignored `<name>.override.*`, dispatched via a thin `script/<name>.sh`)
  for anything new added here — same idiom `router/config/netgate/` and
  `router/script/netgate-*.sh` already use.
- `router/Dockerfile` is this subtree's own build file — `docker-compose.yml`
  builds the `code-docker-router` service with `context: router` (or
  `${BUILD_CONTEXT:-.}/router`), not a stage in the repo-root `Dockerfile`.
  Keep it that way; don't fold router back into the root Dockerfile as a
  stage.
- This container is meaningfully more trusted than code-docker (same
  framing dind-authz uses for dind) — its own packages/config shouldn't be
  reachable from inside code-docker at all, and anything added here should
  be held to that higher trust bar.
- Before running `docker compose build`/`up`/`restart` against a live
  container, confirm it's actually safe — someone else may be iterating on
  it.
