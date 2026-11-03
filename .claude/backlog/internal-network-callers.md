# Unauthenticated APIs on code-docker-internal (audit CF-01, deferred)

Status: **deferred by the owner on 2026-11-03**, to be done together with any
restriction of dind's Docker API. Nothing implemented.

## The premise this rests on

Anything attached to `code-docker-internal` (a sibling project's container,
say) reaches `dind:2375` - unauthenticated, TLS-less, and host-kernel
equivalent (root `CLAUDE.md`, "Security-relevant, intentional trade-offs").
Against that, every other unauthenticated API on the same network grants
less, so none of them is a separate escalation today.

## What becomes reachable once dind is restricted

- **chrome-front's forward API** (`builds/code-docker-chrome`,
  `chrome-front/main.go`'s `api()`, `:8090`): no caller check on
  `GET/POST /api/forwards` or `DELETE /api/forwards/{port}`. A sibling could
  read the table and add, replace or remove the `localhost` forwards Chrome's
  pages use - redirect or break the user's dev page. `targetPolicy` still
  limits where a forward may point, so not a route to router or dind.
- Re-sweep `code-docker-internal` for other listeners at that time; this list
  was written from one audit (Codex, 2026-11-03), not an inventory.

## Shape of the fix for chrome-front (from the audit)

- A token the API requires on every route, reads included (the table shows
  targets and state). Missing or wrong: refuse.
- Only two clients need it: `chrome-ports` inside code-docker, and
  webmanager's provider proxy. Never in a sibling's environment or a shared
  volume.
- **webmanager's provider proxy strips `Authorization`** on the way in
  (`internal/providers`, by design, so the browser's credentials never reach
  a provider). A provider token therefore needs a provider-contract addition
  in `webmanager/CLAUDE.md` - e.g. `WEBMANAGER_PROVIDER_<ID>_TOKEN`, added by
  webmanager itself after the strip.
- Regression shape: unauthenticated read/add/replace/delete refused;
  authenticated allowed; existing target limits unchanged; nothing of the API
  served on chrome-net.

Codex live-check item 12 (2026-11-03) reports whether a sibling actually
reaches both ports; that settles whether the premise above holds as written.
