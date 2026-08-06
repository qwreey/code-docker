# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal Arch Linux-based Docker image bundling `code-server` (browser VS Code), `sshd`, `mise` (runtime version manager), and a Docker-in-Docker sidecar, orchestrated by `supervisord`. There is no application source code, test suite, or linter here — this is infrastructure/config (Dockerfile, shell scripts, YAML). `code-server-autoinstall` is a git submodule (`qwreey/code-server-autoinstall`) providing the actual code-server install/patch machinery; treat it as a vendored dependency, not something to edit casually.

## Commands

```sh
docker compose build   # rebuild the image after Dockerfile/config/script changes
docker compose up -d   # (re)start
docker compose build code-docker && docker compose up -d   # after editing a config/*.override.* file
```

There are no automated tests or linters in this repo. Validate changes by building the image and, when practical, exercising the affected service through `docker compose up` (e.g. checking `docker compose logs`, opening the code-server URL, `ssh`-ing in).

If a repo-root `.allow-test` file exists (gitignored — `touch .allow-test` to create it), the running `docker compose` stack in this checkout is a disposable test environment, not someone's live/in-use instance — building, restarting, and exercising services freely (without asking first) is fine. Without it, treat the stack as potentially live and confirm before rebuilding/restarting.

## Architecture

### The override pattern

Nearly every runtime behavior is defined by a pair of files under `config/`: `<name>.default.*` (checked into git) and an optional `<name>.override.*` (gitignored, user-provided). A `script/<name>.sh` dispatcher execs the override if present, else the default — e.g. `script/code-service.sh` → `config/code-service.default.sh` or `config/code-service.override.sh`. This same pattern applies to `build`, `code-service`, `sshd-service`, `supervisord.conf`, `shell`, and `user-init`. When adding a new customizable behavior, follow this pattern rather than hardcoding logic into the Dockerfile.

`.sh` override files must be `chmod u+x`. Editing an override requires a rebuild (`docker compose build && up`), not just a container restart.

### Process model

`entrypoint.sh` runs `user-init.sh` synchronously (see below) and then starts `supervisord` (config: `config/supervisord.default.conf`), which runs `code` (the supervisord program name — code-server itself, named to match the `code-*` script/config prefix rather than `code-server-*`) and `sshd` as managed programs, plus anything dropped into `config/supervisord/*.conf` (gitignored, auto-`include`d). The `restart` command (in `bin/`, on `PATH`) does `supervisorctl restart code` — this is how users pick up `mise`-installed toolchain changes or patch edits without a full container rebuild.

- `user-init.sh`/`user-init.default.sh` runs once per boot from `entrypoint.sh`, **before** `supervisord` starts (so no other program can race it touching `$HOME`) — `set -e`, so a failed migration kills the container loudly instead of continuing half-migrated. It tracks a version number in `/code/.local/share/code-docker/migration-version` (falls back to reading the pre-migration `/code/.installed`, `mv`d into place on first encounter) and only re-runs the first-time setup (fish shell config, qwreey-fish) once; the pattern is that any future versioned migration step gets added gated on `[ "$OLD_VERSION" -lt N ]`, safe to leave in place indefinitely once its target state already matches. See `.claude/archive/home-structure-plan.md` for the design/rationale behind this pattern — the home-directory consolidation it originally introduced was retired from the script once no container still needed it. It also unconditionally `mkdir -p`s `/code/Projects` on every boot — this container has no DE/browser to run `xdg-user-dirs` for, but webmanager's Projects tab defaults to scanning that path and silently shows nothing if it's missing.
- `code-service.default.sh` delegates to `code-server-autoinstall/start.sh` via `code-runner.default.sh` (which first does `mise env --shell bash` so mise-installed tools are on `PATH` for the service, not just interactive shells).
- `sshd-service.default.sh` inits `/etc/ssh` from `/etc/default/ssh` (baked in at build time from Arch's default config) on first run, then execs `sshd -D`.

Every program's stdout/stderr is captured to a real, rotated file at `/var/log/<program-name>/{stdout,stderr}.log` (supervisord's `%(program_name)s` expansion, same literal line in every `[program:X]` block — see `config/supervisord.default.conf`), not `/dev/fd/1` directly. The `vector` program (`config/vector.default.toml`) tails every program's `stdout.log*`, tags each line with `app_name`, and re-emits a human-labeled `[app_name] message` copy to *its own* stdout (the one program still on `/dev/fd/1`) — that's what makes `docker compose logs` show labeled, readable output again instead of everything interleaved raw. It also writes a structured JSON-lines copy to `/code/.local/share/code-docker/vector/logs/<date>.jsonl` that `webmanager`'s Logs page reads directly (no vector API/network access involved — see `webmanager/backend/internal/logstore`). `stderr.log*` files exist and rotate but aren't tailed by vector.

### Build (Dockerfile)

Multi-stage: `docker:latest` is used only as a source to `COPY --from=docker-bin` the standalone `docker` CLI binary into the Arch image (`/usr/bin/docker`) — this avoids installing the full `docker`/`dockerd` package via pacman just to get the client. `docker-compose` and `docker-buildx` (CLI plugins, `docker` is only an optional dependency for both on Arch) are instead installed normally via pacman in `config/build.default.sh`, alongside `yay` (AUR helper, bootstrapped by `script/install-yay.sh` for anything not in the official repos).

`bin/` is copied to `/usr/local/bin/`, so it's on `PATH` everywhere in the container (not just inside code-server's integrated terminal). Notable entries: `restart` (see above), `code`/`copy` (thin wrappers around the vendored `code-server` CLI, which is actually a symlink to VS Code's `remote-cli` script), and `xclip`/`wl-copy` shims that forward stdin to `code-server -c` (the CLI's `--stdin-to-clipboard` flag) so clipboard tools inside the browser-based terminal work despite OSC 52 not being supported.

### docker-compose topology

Two user-defined networks: `code-docker-external` (has internet/host access) and `code-docker-internal` (`internal: true`, no outside route) — router's tailscale `forwards:` feature (see "router" below) also resolves via a `forward` alias on `code-docker-internal` rather than a dedicated network of its own; there used to be a third `code-docker-forwards` network, dropped once the port-namespace collision it existed to prevent stopped being possible (see the "tailscale" bullet under "router" below). As of the egress lockdown (see "router" below), neither `code-docker` nor `code-docker-dind` (the `docker:dind` sidecar, used so `docker`/`docker compose`/`docker buildx` work *inside* code-docker via `DOCKER_HOST=tcp://dind:2375`) is attached to `code-docker-external` anymore — both live on `code-docker-internal` only, and reach the internet exclusively through the default route their respective netinit-style loop keeps planting, pointed at the `code-docker-router` service, the only container attached to both networks. All service/network names are prefixed with `${PREFIX:-}` to let multiple instances coexist on one host without name collisions (set `PREFIX` in `.env`).

`code-docker-dind` doesn't use the stock `docker:dind` entrypoint directly — the `dind` stage in the root `Dockerfile` (`FROM docker:dind`) `COPY`s in `script/dind-entrypoint.sh` as its `ENTRYPOINT`, and `code-docker-dind` builds that stage (`build: {context: ., target: dind}`) instead of using `image: docker:dind`, so the daemon binds only to its `code-docker-internal` IP instead of the image's hardcoded `0.0.0.0:2375` (it picks that IP dynamically at startup, by finding the interface with no default route — `code-docker-internal` being the only network without one — rather than hardcoding an address). Baking it in at build time (rather than bind-mounting the script at runtime) means it isn't tied to the compose file's on-disk location — same `context:` override as the main `code-docker` service covers both.

**Always address `code-docker-dind` via the `dind` alias, never the bare service name.** `dind` is a network-scoped alias defined only on `code-docker-internal` (see `networks.code-docker-dind.code-docker-internal.aliases` in docker-compose.yml). Now that neither service is attached to `code-docker-external`, the bare name isn't ambiguous by default the way it used to be — but it becomes ambiguous again the moment `code-docker-external` is restored on either service (e.g. via the manual opt-out described below), so keep using the alias regardless. Use it for `DOCKER_HOST` and for reaching any port published by a container created inside dind.

**Security-relevant, intentional trade-offs** (documented in README, keep in sync when touching these):
- `code-config.default.yaml` sets `auth: none` — code-server itself has no login; a reverse proxy with forward-auth (e.g. Caddy + Authentik) is expected in front of it.
- `code-docker-dind` runs `privileged: true` with an unauthenticated, TLS-less daemon socket (`DOCKER_TLS_CERTDIR: ""`). It's only reachable from `code-docker-internal` — but anyone who can reach `code-docker-internal` still gets host-kernel-equivalent access. Data persists via `./dind:/var/lib/docker`.
- `cap_add: SYS_PTRACE` (debuggers like gdb/btop that trace other processes) and `IPC_LOCK` (avoids IPC-related perf bottlenecks — IDEs/LSPs do a lot of IPC) are added by default.
- Containers created *inside* `code-docker-dind` (e.g. `docker run postgres` from within code-docker) live in the inner daemon's own private network — they are **not** reachable by name on `code-docker-internal`; reach them via `dind:<published-port>`. This is inherent to nested Docker-in-Docker (separate daemon, separate netns/network store) and was deliberately not "fixed" by switching to Docker-outside-of-Docker (host socket mount), since that would remove the one layer of isolation the nested daemon currently provides.

### router

A separate container (`code-docker-router`, `router/` — its own subtree with its own
`CLAUDE.md`/`plan.md`) that owns everything about code-docker's network boundary — it has
meaningfully higher trust than code-docker, the same "국경을 넘는 컨테이너" framing as
dind-authz. It grew from a pure egress-filtering sidecar (originally named
`code-docker-netgate`) into the full boundary container described here across a staged
migration; see `router/.claude/functional-router-plan.md` for the vision/every decision
and `.claude/backlog/egress-netgate-plan.md` for the original egress design router's
netgate feature area is still built on. User-facing docs: `docs/router.md`,
`docs/egress-netgate.md`, `docs/dev-proxy.md`, `docs/tailscale.md` (now a short pointer
into `docs/router.md`).

Four feature areas, each its own supervisord programs (`router/config/supervisord.d/*.conf`,
git-tracked built-in program definitions — see `router/config/netgate/supervisord.default.conf`'s
own comment on the two `[include]` globs, one git-tracked for built-ins, one gitignored for
user overrides, same auto-include idiom as the main image's `config/supervisord.default.conf`):

- **netgate (egress lockdown)** — netinit-style routing enforcement (code-docker/dind side)
  plus router's own filtering (DNS-level content blocklist via dnsmasq, RFC1918/CIDR
  blocking, inbound port-forwarding). `code-docker-netinit` is a small sidecar built from the `netinit`
  Dockerfile stage. It runs with `network_mode: service:code-docker` (shares code-docker's
  netns entirely — same interfaces/IP/routing table, not a separate IP) and
  `cap_add: [NET_ADMIN]`, a capability code-docker itself never gets. `script/netinit-entrypoint.sh`
  loops every 5s doing `ip route replace default via <router's resolved IP>`, defensively
  (never exits non-zero, tolerates `router` not resolving) — this is what keeps code-docker's
  default route pointed at router without code-docker ever being able to undo it.
  `code-docker-dind` needs no separate sidecar for the same mechanism — it's already
  `privileged: true`, so `script/dind-entrypoint.sh` runs the identical loop itself
  (backgrounded before its final `exec`, wrapped in `tini` so dockerd-as-PID-1 doesn't
  accumulate zombies from the loop's repeated `ip`/`getent` forks). `script/entrypoint.sh`
  gates everything network-sensitive (starting with `user-init.sh`'s qwreey-fish curl)
  behind a bounded poll (60s timeout) for `ip route show default` to be non-empty — this is
  what code-docker waits on for netinit to have planted a route, without a compose-level
  `depends_on` cycle (route *reads* need no capability, only *writes* do). `router` is the
  only container attached to both `code-docker-internal` and `code-docker-external`,
  `cap_add: [NET_ADMIN]` only (no `privileged: true`).
  - `[program:netgate-firewall]` (`router/config/netgate/firewall.default.sh`) loops every
    30s reading `router/config/netgate/config.default.yaml` (override pattern) via `yq -r`
    and translating it into iptables: an ordered `outbound:` allow/block CIDR list
    (first-match-wins, specific exceptions before broad blocks — default blocks RFC1918 +
    link-local + loopback) and a `forwards:` port-forwarding list (default: host `80` →
    `code-docker:80`, generalized to any `code-docker-internal` hostname, not hardcoded). A
    forward's ACCEPT rule always lands before the CIDR blocks, since the target's own IP is
    itself in RFC1918 range. A stateful `ESTABLISHED,RELATED` ACCEPT rule comes first of all
    — without it, return traffic for an already-permitted connection (e.g. the port-80
    DNAT's reply) gets re-evaluated against the block rules and dropped, since Docker's own
    bridge subnets are themselves RFC1918 addresses. `net.ipv4.ip_forward=1` is set via this
    service's own `sysctls:` in docker-compose.yml, not a runtime `sysctl -w` — Docker keeps
    `/proc/sys` read-only for non-privileged containers regardless of `NET_ADMIN`, so a
    runtime write silently fails with permission denied. Same-subnet traffic (code-docker↔dind,
    code-docker↔router) never reaches this chain at all — connected-route traffic bypasses
    the gateway entirely, so no RFC1918 exception is needed for `code-docker-internal`'s own
    CIDR.
  - `[program:dns]` (`router/config/dns/dns.default.sh` +
    `router/config/dns/dnsmasq.default.conf`) is code-docker/dind's DNS resolver —
    `code-docker-internal` being `internal: true` means Docker's own embedded DNS
    (`127.0.0.11`) refuses to forward queries externally, so code-docker/dind point their
    `/etc/resolv.conf` at router instead (see `router/.claude/router-dns-plan.md`), and
    dnsmasq forwards upstream using router's own (working, non-internal) `/etc/resolv.conf`.
    This also doubles as the content blocklist enforcement point: dnsmasq's
    `addn-hosts=/etc/code-docker/dns/blocklist.default.hosts` answers `0.0.0.0` for any
    domain in the baked-in StevenBlack/hosts file (no format conversion needed — dnsmasq
    reads hosts-format directly), with `router/config/dns/blocklist.override.hosts` layered
    on top via an extra `--addn-hosts=` flag (additive, not a replacement) if present. This
    replaced an earlier squid-based intercept/SNI-block approach (`REDIRECT` on ports 80/443
    to squid, blocking by `dstdomain`/SNI) — removed because squid's `ssl_bump` anti-spoofing
    check false-positived on CDN-style domains with rotating IP pools (e.g.
    `registry-1.docker.io`), breaking `docker pull`. Block-only, no whitelist mode, and
    still explicitly best-effort/passive (adblock-like) — the hard boundary remains the
    RFC1918/CIDR FORWARD rules above.
  - `NETGATE_ENABLED` (env, default `true`) is a **behavioral** opt-out only — `false`
    makes the netinit/dind/router loops idle and skips entrypoint.sh's wait gate. It does
    **not** restore `code-docker-external`/`ports: - 80:80` on code-docker or dind —
    Compose can't conditionally attach a network or publish a port based on a runtime env
    var, so a full topology rollback is a deliberate manual edit to docker-compose.yml (same
    spirit as `DIND_TARGET=dind` to fully disable dind-authz) — see example-env's
    `NETGATE_ENABLED` comment for the exact steps. `profiles:` was considered for this
    opt-out and rejected: Compose profiles are opt-in by nature (a profiled service only
    starts when its profile is explicitly activated), which can't express "on by default
    even with zero `.env` file" — a hard requirement here per this repo's "works with no
    `.env` at all" philosophy.
- **tailscale** — `tailscaled`, `tailscale-forward`, and `tailscale-publish` run as three
  separate, single-responsibility supervisord programs (`router/config/tailscale/*.default.sh`),
  deliberately kept apart so e.g. editing `config.yaml` and restarting `tailscale-forward`
  never touches the `tailscaled` login session or `tailscale-publish`. Moved here from
  code-docker in full (daemon+login+forwards+publish, not partial) — code-docker itself has
  zero tailscale processes/packages now. `TAILSCALE_ENABLED`/`TAILSCALE_LOGIN_SERVER`/
  `TAILSCALE_HOSTNAME` (docker-compose env, same names as before the move) configure it.
  Inbound: `tailscaled`'s netstack auto-forwards any tailnet connection to the same port on
  `127.0.0.1`, unconditionally, for any port with no `tailscale serve` rule (core
  `tailscaled` behavior) — since code-docker no longer runs tailscaled at all, this only
  matters for router's own ports now, not code-docker's. Outbound (forwards): `socat` piped
  through `tailscaled`'s local SOCKS5 proxy, listening on router's own `forward` alias on
  `code-docker-internal` (moved from code-docker's own now-removed dedicated
  `code-docker-forwards` network — forwards/publish sharing a port namespace was only ever
  a risk while both lived inside code-docker itself; now that forwards' socat and publish's
  `tailscale serve` both live on router, and publish proxies to a *different* container
  rather than binding a local port at all, that collision can't happen, so the extra network
  was dropped) so `forward:<port>` still resolves from inside code-docker, now pointing at
  router.
  `${ROUTER_VOLUME:-./router-data}/tailscale/config.yaml` (seeded from
  `router/config/tailscale/tailscale-config.default.yaml`) drives `forwards:`/`publish:` —
  MagicDNS names are deliberately never used as forward/publish targets (too dynamic,
  can even point at something outside the tailnet on self-hosted control servers), only
  tailscale hostnames/IPs. `publish:` targets code-docker directly by its plain compose
  service hostname now (no alias dance needed — that was only ever about dodging
  code-docker's *own* tailscaled's auto-exposure, moot once tailscaled isn't there).
  router-manager (below) replaces the old status-polling shell script with a real read-only
  HTTP endpoint. `bin/forward-reload` (in code-docker's PATH) no longer works from inside
  code-docker — it now just prints the `docker compose exec code-docker-router
  supervisorctl restart ...` command needed instead, since it can't reach router's
  supervisorctl socket from a different container.
- **Dev Proxy** — an internal Caddy instance (`caddy-adapter` program,
  `router/config/caddy-adapter/caddy-adapter.default.sh`) exposing dev servers on wildcard
  subdomains, managed via router-manager's API (`router/backend/internal/devproxy`,
  `CADDY_ADAPTER_ENABLED`/`CADDY_ADAPTER_PORT` env, same names as before the move — also
  read by code-docker's nginx to build its `/exports/` proxy target). Moved here from
  code-docker in full, same reasoning as tailscale.
- **tinyauth** — router's own forward-auth (`ghcr.io/tinyauthapp/tinyauth`, a separate
  `code-docker-tinyauth` compose service using the official image — not built from source
  like dind-authz, since tinyauth's Dockerfile requires a mandatory pnpm/Vue frontend build
  ahead of its Go build, unlike a plain single-binary build). Protects individual Dev Proxy
  routes that opt into "require auth" (Caddy `forward_auth` → tinyauth's
  `/api/auth/caddy`) — a separate, lighter tool from webmanager's own `internal/authgate`,
  which stays exactly as-is, scoped only to webmanager's own Terminal/File Manager/Logs.
  `TINYAUTH_AUTH_USERS` (docker-compose env) is empty by default — no one can log in until
  set (`docker run --rm ghcr.io/tinyauthapp/tinyauth:v5 user create --username <u>
  --password <p> --docker` generates the value).

router-manager is router's own Go backend (`router/backend`, mirrors webmanager's own
backend pattern) — proxied in by code-docker's nginx (`config/nginx.default.conf`'s
`/tailscale/`/`/dev-proxy/`/`/router-auth/` locations, private-by-default — no
host-published port on router-manager itself): full tailscale CRUD (`GET`/`PUT
/api/tailscale/config`, `GET`/`POST`/`DELETE /api/tailscale/forwards[/{name}]`,
same for `/publish`, `GET /api/tailscale/status`, `POST /api/tailscale/login/
{start,cancel}`, plus the original read-only `GET /api/tailscale/state`
— `{backendState, authUrl}`, same shape the old status-polling script wrote —
code-server's sign-in banner, `config/code-patch/tailscale-notify.default.js`,
polls this now instead of a static file), the Dev Proxy expose CRUD webmanager's
Dev Proxy tab calls, and `POST /api/auth/unlock` + `GET /api/auth/status` for
router-manager's own admin-API password gate (see below). `/exports/` (actual
end-user traffic to an exposed dev server) is a separate nginx location from
`/dev-proxy/` (the admin API) — don't confuse the two.

router's own frontend (`router/frontend`, `@code-docker/router-frontend` — an npm workspace
package, root `package.json`'s `workspaces:`) owns the actual page components; webmanager's
`App.tsx` imports them directly (`import { DevProxy, Tailscale, RouterUnlockModalHost } from
'@code-docker/router-frontend'`) rather than owning that UI itself — see "webmanager" below and
`router/.claude/functional-router-plan.md`'s "router ↔ webmanager 프론트 통합 방식". Both
Dev Proxy and Tailscale (forwards/publish/login CRUD + status view) are ported this way.

router-manager's own admin-API auth (`router/backend/internal/authgate`, opt-in via
`ROUTER_MANAGER_AUTH_PASSWORD_HASH`, off by default) gates every *mutating* route above
(tailscale config/forwards/publish/login writes, dev-proxy expose writes) — reads (state,
config, list, status) stay open. A separate gate/cookie from webmanager's own
`internal/authgate` below (different process, different secret) — `router-manager
--hash-password` generates the argon2id hash, see example-env's
`ROUTER_MANAGER_AUTH_PASSWORD_HASH` comment. `RouterUnlockModalHost` (mounted in
webmanager's `App.tsx` next to its own `UnlockModalHost`) pops on any 401 from a gated
router-manager route, same "prompt → retry once" pattern webmanager's own gate uses. See
`router/plan.md` for the design history (this closed out the item that was previously
tracked there as "보류/미정").

`config/code-patch/` is a generic mechanism, not tailscale-specific: any `<name>.default.<ext>` there (with an optional matching gitignored `<name>.override.<ext>`) gets seeded by `code-patch.default.sh` into `/code/.local/share/code-docker/code/patch/<name>.<ext>` — code-server-autoinstall auto-injects every top-level `patch/*.js` as a `<script>` tag on every start (see "코드 서버 패치" in README). Re-seeded on *every* boot, but only when the live target's content still hashes to what was seeded last time (`/code/.local/share/code-docker/code/.code-patch-manifest` now tracks `<name>\t<hash>` pairs, not just names) — i.e. a bundled `.default.`/`.override.` fix actually reaches an already-running container instead of the old "only copy if missing" behavior silently freezing the target at whatever was first seeded forever. If the live file's hash doesn't match (user edited it directly, or there's no recorded hash yet — e.g. a target that predates this hash-tracking), it's left alone; a `.default.` file removed in a later code-docker version still gets its old target removed too instead of orphaned forever. Because there's no historical hash for anything seeded before this behavior shipped, upgrading alone won't retroactively re-apply a fixed default to an already-seeded file that was never otherwise touched — delete the file under `/code/.local/share/code-docker/code/patch/` once to force a fresh reseed with hash-tracking from then on. `code-patch.default.sh` is invoked from `code-service.default.sh` (not `user-init.default.sh` — that one's scoped to home-folder/shell setup like fish config, not code-server internals), deliberately *after* `install.sh` so `/code/.local/share/code-docker/code` actually exists by the time it runs.

### webmanager

A browser admin panel (Go backend + Vite/React frontend, `webmanager/` — its own subtree, with its own `CLAUDE.md`/`plan.md`) running alongside code-server as another supervisord program, on port 81. Well beyond its original scope now: supervisord process management, SSH `authorized_keys`/`known_hosts`, git config (commit signing/GPG, git-lfs, raw `.gitconfig` editing), the vector-backed logs pipeline described above, an OS-level process/port viewer with resource-history graphs, a Projects-folder browser with a per-project git status panel, code-server extension and mise tool management, a Claude Code status tab, Docker/dind management, a Dev Proxy tab (imported from `@code-docker/router-frontend` — see "router" above, the actual Caddy instance/backend live on the router container, not here), a web terminal (ephemeral PTY sessions), and a full file manager — see `webmanager/plan.md` for the up-to-date implemented/TODO split. Most of it still has no login of its own and relies entirely on the same reverse-proxy forward-auth as code-server; an opt-in shared password gate (`internal/authgate`, off by default) additionally protects the Terminal/File Manager tabs entirely and gates write actions elsewhere (see `webmanager/.claude/archive/authgate-plan-done.md`) — note this gate no longer covers Dev Proxy or Tailscale at all; both moved to router-manager's own API and are gated by router-manager's own separate `internal/authgate` instance instead (`ROUTER_MANAGER_AUTH_PASSWORD_HASH` — see "router" above).

## Documentation

`README.md` is now just a short intro (screenshot + one paragraph + a pointer into `docs/`) — as of 2026-08-05 the actual user-facing content that used to live there (setup, the override customization system mirroring the "override pattern" above but from a user's perspective, and a "tips" section per integration: ssh, adb, Discord presence, dind, clipboard, multi-instance via `PREFIX`) moved to `docs/index.md`, with per-topic detail pages alongside it (`docs/build-customization.md`, `docs/router.md` (the router container's own doc — tailscale/Dev Proxy/tinyauth), `docs/tailscale.md` (now just a short pointer into `docs/router.md`), `docs/dev-proxy.md`, `docs/egress-netgate.md`, `docs/webmanager.md`, `docs/webmanager-config.md`, `docs/security-login.md`, `docs/code-server-patch.md`, `docs/tips/*.md`). This was done anticipating that `docs/` gets bundled/rendered inside webmanager itself someday (see `webmanager/.claude/research/guide-plan.md`) — keeping it as its own directory rather than scattered across the repo root makes that easier. When adding a new customizable file or a new environment trick, add a matching entry to `docs/index.md` (or the relevant `docs/*.md` page) in the same style as the existing ones — not `README.md`. A revamp plan for the now-short `README.md` itself (badges, a tighter intro) is tracked in `.claude/backlog/readme-revamp-plan.md`.
