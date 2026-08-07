# router

Scoped guidance for anyone (human or agent) working under `router/`. Read
`plan.md` first — it's kept short (current status + a linked TODO only).
This subtree follows the same convention as `webmanager/` (see that
subtree's own `CLAUDE.md` for the fully-grown example): `router/CLAUDE.md` +
`router/plan.md` at the subtree root, feature-specific design/history docs
under `router/.claude/` (`router/.claude/functional-router-plan.md` —
the vision/every-decision doc, mostly implemented now, see `plan.md` —
and `router/.claude/router-dns-plan.md`; `router/.claude/archive/` holds
done/superseded design docs, e.g. `tailscale-design.md`, the original
tailscale-in-code-docker design this container's own tailscale feature
superseded).

## What this is

The network-boundary container for code-docker — see
`router/.claude/functional-router-plan.md` for the full vision and every
design decision, and `.claude/backlog/egress-netgate-plan.md` (repo root —
stays there since it also covers code-docker/dind's own netinit-style
routing loops, not just this container) for the egress/DNAT design this
container started from (it was `code-docker-netgate` before being promoted
to this subtree). Don't re-derive decisions already recorded there.

## Current state

The netgate→router migration described in `functional-router-plan.md` is
complete (see `plan.md`) — every feature area it envisioned now lives here:

- **netgate** — outbound CIDR filtering via iptables, DNS-level content
  blocklist + resolver via dnsmasq, inbound DNAT (`router/config/netgate/`,
  `router/config/dns/`, `router/script/`).
- **tailscale** — daemon, login, `forwards:`/`publish:`, and a full
  router-manager-backed admin API + UI (moved from code-docker in full;
  code-docker itself runs no tailscale process at all anymore) —
  `router/config/tailscale/`, `router/backend/internal/tailscale/`,
  `router/frontend/src/components/Tailscale/`.
- **Dev Proxy** — an internal Caddy instance exposing dev servers on
  wildcard subdomains, managed via router-manager — `router/config/caddy-adapter/`,
  `router/backend/internal/devproxy/`, `router/frontend/src/components/DevProxy/`.
- **tinyauth** — forward-auth for individual Dev Proxy routes that opt into
  it, run as a plain supervisord program in this container (`router/config/tinyauth/`)
  — its binary is multi-stage-extracted from `ghcr.io/tinyauthapp/tinyauth` in
  `router/Dockerfile`, not built from source, and not a separate compose service.

router-manager (`router/backend`) is this container's own Go backend
(mirrors webmanager's pattern) exposing all of the above's mutating/read
routes, gated by its own opt-in password gate
(`router/backend/internal/authgate`, `ROUTER_MANAGER_AUTH_PASSWORD_HASH`) —
separate from webmanager's own gate. `router/frontend`
(`@code-docker/router-frontend`) is an npm workspace package webmanager
imports directly rather than owning this UI itself.

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
