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

Nearly every runtime behavior is defined by a pair of files under `config/`: `<name>.default.*` (checked into git) and an optional `<name>.override.*` (gitignored, user-provided). A `script/<name>.sh` dispatcher execs the override if present, else the default — e.g. `script/code-service.sh` → `config/code/code-service.default.sh` or `config/code/code-service.override.sh`. This same default/override selection pattern applies to `build`, `code-service`, `sshd-service`, `supervisord.conf`, `shell`, and `user-init` — with two naming exceptions: `shell`'s dispatcher is `script/get-user-shell.sh` (not `script/shell.sh`), and `supervisord.conf`'s override-or-default choice is made inline in `entrypoint.sh` itself rather than via a separate dispatcher script. When adding a new customizable behavior, follow this pattern rather than hardcoding logic into the Dockerfile.

`config/` is organized into one subfolder per program — `build/`, `code/` (code-server itself, including `code-patch/` and `recommendations.default.yaml`), `nginx/`, `resolv-writer/`, `shell/`, `sshd/`, `user-init/`, `vector/`, `webmanager/` — same per-feature-folder idiom `router/config/` uses (`dns/`, `tailscale/`, `netgate/`, ...). The root Dockerfile `COPY`s the whole `config` tree in one shot (`COPY config ... /etc/code-docker/`), so this nesting carries straight through to the runtime paths dispatcher scripts reference (`config/code/code-service.default.sh` → `/etc/code-docker/code/code-service.default.sh`) with no extra Dockerfile wiring needed per folder. `supervisord.default.conf`, `supervisord.d/*.conf`, and `supervisor-metadata.default.yaml` stay directly under `config/` instead of a program folder — they're cross-cutting infra (supervisord itself, and per-program metadata webmanager reads about *every* program), not owned by any single program the way the folders above are.

`.sh` override files must be `chmod u+x`. Editing an override requires a rebuild (`docker compose build && up`), not just a container restart.

### Process model

`entrypoint.sh` runs `user-init.sh` synchronously (see below) and then starts `supervisord` (config: `config/supervisord.default.conf`, trimmed to just the `[supervisord]`/`[unix_http_server]`/`[supervisorctl]`/`[rpcinterface]`/`[include]` boilerplate), which runs `code` (the supervisord program name — code-server itself, named to match the `code-*` script/config prefix rather than `code-server-*`) and `sshd` as managed programs, each defined in its own file under `config/supervisord.d/*.conf` (git-tracked, one `[program:...]` per file — code, resolv-writer, sshd, webmanager, nginx, vector — same split idiom router's own `netgate/supervisord.default.conf` uses for its feature programs), plus anything dropped into `config/supervisord/*.conf` (gitignored, auto-`include`d, for a user's own runtime override/addition — no placeholder directory is checked into git for this one; the root Dockerfile `mkdir -p`s it directly instead, see the "Log directories" comment near that line). The `restart` command (in `bin/`, on `PATH`) does `supervisorctl restart code` — this is how users pick up `mise`-installed toolchain changes or patch edits without a full container rebuild.

- `user-init.sh`/`user-init.default.sh` runs once per boot from `entrypoint.sh`, **before** `supervisord` starts (so no other program can race it touching `$HOME`) — `set -e`, so a failed migration kills the container loudly instead of continuing half-migrated. It tracks a version number in `/code/.local/share/code-docker/migration-version` (falls back to reading the pre-migration `/code/.installed`, `mv`d into place on first encounter) and only re-runs the first-time setup (fish shell config, qwreey-fish) once; the pattern is that any future versioned migration step gets added gated on `[ "$OLD_VERSION" -lt N ]`, safe to leave in place indefinitely once its target state already matches. See `.claude/archive/home-structure-plan.md` for the design/rationale behind this pattern — the home-directory consolidation it originally introduced was retired from the script once no container still needed it. It also unconditionally `mkdir -p`s `/code/Projects` on every boot — this container has no DE/browser to run `xdg-user-dirs` for, but webmanager's Projects tab defaults to scanning that path and silently shows nothing if it's missing.
- `code-service.default.sh` delegates to `code-server-autoinstall/start.sh` via `code-runner.default.sh` (which first does `mise env --shell bash` so mise-installed tools are on `PATH` for the service, not just interactive shells).
- `sshd-service.default.sh` inits `/etc/ssh` from `/etc/default/ssh` (baked in at build time from Arch's default config) on first run, then execs `sshd -D`.

Every program's stdout/stderr is captured to a real, rotated file at `/var/log/<program-name>/{stdout,stderr}.log` (supervisord's `%(program_name)s` expansion, same literal line in every `[program:X]` block — see `config/supervisord.default.conf`), not `/dev/fd/1` directly. The `vector` program (`config/vector/vector.default.toml`) tails every program's `stdout.log*`, tags each line with `app_name`, and re-emits a human-labeled `[app_name] message` copy to *its own* stdout (the one program still on `/dev/fd/1`) — that's what makes `docker compose logs` show labeled, readable output again instead of everything interleaved raw. It also writes a structured JSON-lines copy to `/code/.local/share/code-docker/vector/logs/<date>.jsonl` that `webmanager`'s Logs page reads directly (no vector API/network access involved — see `webmanager/backend/internal/logstore`). `stderr.log*` files exist and rotate but aren't tailed by vector.

### netshare

`netshare/` (repo root) is a small shared POSIX `sh` function library for the network-bootstrap logic that used to be hand-duplicated across `script/entrypoint.sh`, `netinit/script/netinit-entrypoint.sh`, `code-dind/script/dind-entrypoint.sh`, and `config/resolv-writer/resolv-writer.default.sh`: `wait-until.sh` (`wait_until` — generic poll-until-timeout), `apply-route.sh` (`apply_default_route` — resolve a hostname and `ip route replace` the default route to it, plus the "unexpected extra default route" warning), and `apply-nameserver.sh` (`apply_nameserver` — resolve a hostname and write it into `/etc/resolv.conf` as a fallback nameserver). Every consumer sources whichever function files it needs rather than exec'ing the whole thing. code-docker's own Dockerfile builds from the repo root, so it `COPY`s `netshare/` directly; `netinit/` and `code-dind/` each have their own isolated build context (see their own `CLAUDE.md`s) and can't reach it that way, so `vendor-netshare.sh` (repo root, same idea as `vendor-envmigrate.sh` for the `envmigrate/` Go module, but a plain file copy since there's no package manager for a few sourced shell functions) hand-copies `netshare/*.sh` into `netinit/script/netshare/` and `code-dind/script/netshare/` — **run it after editing anything under `netshare/`, before rebuilding either of those images**; unlike `go mod vendor`, there's no build-time staleness check, so a forgotten vendor step is a silent bug, not a build error. This is deliberately function-per-file and dependency-free so it's easy to eventually promote to a real git submodule the way `code-server-autoinstall` already is, once it's worth the overhead — not done yet.

### Build (Dockerfile)

The root `Dockerfile` builds only the `code-docker` image itself now — `code-docker-dind` (`code-dind/Dockerfile`) and `code-docker-netinit` (`netinit/Dockerfile`) moved out to their own self-contained subtrees, same pattern as `router/` (own Dockerfile, own build context — see `code-dind/CLAUDE.md`/`netinit/CLAUDE.md`). `code-dind/` is named that, not `dind`, originally to avoid colliding with runtime data directories that lived at the repo root next to it (see `code-dind/CLAUDE.md`'s "Naming" section — before this split, the `dind-authz` Go module's source and the `DIND_AUTHZ_VOLUME` runtime mount default were both literally `./dind-authz`, a real collision the split incidentally fixed). Every runtime data directory (`DIND_VOLUME`, `DIND_AUTHZ_VOLUME`, `HOME_VOLUME`, `SSHD_VOLUME`, `ROUTER_VOLUME`) now defaults under a single repo-root `data/` folder instead (`./data/dind`, `./data/dind-authz`, `./data/code`, `./data/sshd`, `./data/router`) so source subtrees and runtime data can never share a naming namespace at all, and `ls` at the repo root reads as source only.

Multi-stage: `docker:latest` is used only as a source to `COPY --from=docker-bin` the standalone `docker` CLI binary into the Arch image (`/usr/bin/docker`) — this avoids installing the full `docker`/`dockerd` package via pacman just to get the client. `docker-compose` and `docker-buildx` (CLI plugins, `docker` is only an optional dependency for both on Arch) are instead installed normally via pacman in `config/build/build.default.sh`, alongside `yay` (AUR helper, bootstrapped by `script/install-yay.sh` for anything not in the official repos).

`bin/` is copied to `/usr/local/bin/`, so it's on `PATH` everywhere in the container (not just inside code-server's integrated terminal). Notable entries: `restart` (see above), `code`/`copy` (thin wrappers around the vendored `code-server` CLI, which is actually a symlink to VS Code's `remote-cli` script), and `xclip`/`wl-copy` shims that forward stdin to `code-server -c` (the CLI's `--stdin-to-clipboard` flag) so clipboard tools inside the browser-based terminal work despite OSC 52 not being supported.

### docker-compose topology

Two user-defined networks: `code-docker-external` (has internet/host access) and `code-docker-internal` (`internal: true`, no outside route) — router's tailscale `forwards:` feature (see "router" below) also resolves via a `forward` alias on `code-docker-internal` rather than a dedicated network of its own; there used to be a third `code-docker-forwards` network, dropped once the port-namespace collision it existed to prevent stopped being possible (see the "tailscale" bullet under "router" below). As of the egress lockdown (see "router" below), neither `code-docker` nor `code-docker-dind` (the `docker:dind` sidecar, used so `docker`/`docker compose`/`docker buildx` work *inside* code-docker via `DOCKER_HOST=tcp://dind:2375`) is attached to `code-docker-external` anymore — both live on `code-docker-internal` only, and reach the internet exclusively through the default route their respective netinit-style loop keeps planting, pointed at the `code-docker-router` service, the only container attached to both networks. All service/network names are prefixed with `${PREFIX:-}` to let multiple instances coexist on one host without name collisions (set `PREFIX` in `.env`).

`code-docker-dind` doesn't use the stock `docker:dind` entrypoint directly — the `dind` stage in `code-dind/Dockerfile` (`FROM docker:dind`) `COPY`s in `code-dind/script/dind-entrypoint.sh` as its `ENTRYPOINT`, and `code-docker-dind` builds a stage derived from it (`target: "${DIND_TARGET:-dind-authz}"` in docker-compose.yml — `dind-authz` is the default, layering an authorization plugin that denies privileged/host-escalation container creation on top of the plain `dind` stage; `dind-authz-remap` adds userns-remap on top of that; see the Dockerfile's own stage comments and `docs/tips/dind.md`) instead of using `image: docker:dind`, so the daemon binds only to its `code-docker-internal` IP instead of the image's hardcoded `0.0.0.0:2375` (it picks that IP dynamically at startup, by finding the interface with no default route — `code-docker-internal` being the only network without one — rather than hardcoding an address). Baking it in at build time (rather than bind-mounting the script at runtime) means it isn't tied to the compose file's on-disk location — same `context:` override pattern as `router`'s own self-contained subtree (see `code-dind/CLAUDE.md`'s "Naming" section for why this subtree is called `code-dind`, not `dind`). Being `privileged: true` already, it manages its own default route and `/etc/resolv.conf` directly (via `netshare`'s `apply_default_route`/`apply_nameserver`, see the "netshare" section above) instead of needing a `netinit`-style sidecar — but unlike code-docker (which only ever *waits* for a route netinit already set), dind applies both once, synchronously, *before* `dockerd` starts, then keeps a background loop running for upkeep. That synchronous-first step matters: `dockerd` snapshots `/etc/resolv.conf` at its own startup to seed the DNS every nested `docker run` container gets from then on, so backgrounding this unconditionally (the original implementation) could lose a race against `dockerd`'s own startup and leave nested containers with no working upstream DNS baked in for the rest of the daemon's life, even though dind's own `/etc/resolv.conf` looked correct moments later.

**Always address `code-docker-dind` via the `dind` alias, never the bare service name.** `dind` is a network-scoped alias defined only on `code-docker-internal` (see `networks.code-docker-dind.code-docker-internal.aliases` in docker-compose.yml). Now that neither service is attached to `code-docker-external`, the bare name isn't ambiguous by default the way it used to be — but it becomes ambiguous again the moment `code-docker-external` is restored on either service (e.g. via the manual opt-out described below), so keep using the alias regardless. Use it for `DOCKER_HOST` and for reaching any port published by a container created inside dind.

**Security-relevant, intentional trade-offs** (documented in README, keep in sync when touching these):
- `code-config.default.yaml` sets `auth: none` — code-server itself has no login; a reverse proxy with forward-auth (e.g. Caddy + Authentik) is expected in front of it.
- `code-docker-dind` runs `privileged: true` with an unauthenticated, TLS-less daemon socket (`DOCKER_TLS_CERTDIR: ""`). It's only reachable from `code-docker-internal` — but anyone who can reach `code-docker-internal` still gets host-kernel-equivalent access. Data persists via `./data/dind:/var/lib/docker`.
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
  blocking, inbound port-forwarding). `code-docker-netinit` is a small sidecar built from its
  own self-contained subtree (`netinit/` — own Dockerfile/build context, see
  `netinit/CLAUDE.md`; same pattern as `router/` and `code-dind/`). It runs with
  `network_mode: service:code-docker` (shares code-docker's
  netns entirely — same interfaces/IP/routing table, not a separate IP) and
  `cap_add: [NET_ADMIN]`, a capability code-docker itself never gets. `netinit/script/netinit-entrypoint.sh`
  loops every 5s doing `ip route replace default via <router's resolved IP>`, defensively
  (never exits non-zero, tolerates `router` not resolving) — this is what keeps code-docker's
  default route pointed at router without code-docker ever being able to undo it.
  `code-docker-dind` needs no separate sidecar for the same mechanism — it's already
  `privileged: true`, so `code-dind/script/dind-entrypoint.sh` runs the identical loop itself
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
  `${ROUTER_VOLUME:-./data/router}/tailscale/config.yaml` (seeded from
  `router/config/tailscale/tailscale-config.default.yaml`) drives `forwards:`/`publish:` —
  MagicDNS names are deliberately never used as forward/publish targets (too dynamic,
  can even point at something outside the tailnet on self-hosted control servers), only
  tailscale hostnames/IPs. `publish:` targets code-docker directly by its plain compose
  service hostname now (no alias dance needed — that was only ever about dodging
  code-docker's *own* tailscaled's auto-exposure, moot once tailscaled isn't there).
  router-manager (below) replaces the old status-polling shell script with a real read-only
  HTTP endpoint, and its own `/api/tailscale/forwards`/`/api/tailscale/publish`
  CRUD already persists+restarts the affected program in one call — editing
  `config.yaml` by hand and reloading via `docker compose exec
  code-docker-router supervisorctl restart ...` (see docs/router.md) is only
  needed if you bypass that API. `bin/forward-reload` (the old code-docker-side
  shortcut for printing that command) was removed since it couldn't actually
  reach router's supervisorctl socket from a different container and the API
  path above makes it unnecessary.
- **Dev Proxy** — an internal Caddy instance (`caddy-adapter` program,
  `router/config/caddy-adapter/caddy-adapter.default.sh`) exposing dev servers on wildcard
  subdomains, managed via router-manager's API (`router/backend/internal/devproxy`,
  `CADDY_ADAPTER_ENABLED`/`CADDY_ADAPTER_PORT` env, same names as before the move — also
  read by code-docker's nginx to build its `/exports/` proxy target). Moved here from
  code-docker in full, same reasoning as tailscale.
- **tinyauth** — router's own forward-auth, run as a plain supervisord program inside
  router itself (`router/config/tinyauth/tinyauth.default.sh`), not a separate compose
  service — `router/Dockerfile` multi-stage-extracts the prebuilt binary straight from
  `ghcr.io/tinyauthapp/tinyauth` (its own Dockerfile requires a mandatory pnpm/Vue
  frontend build ahead of its Go build, so it isn't rebuilt from source like dind-authz,
  but the finished binary itself needs no such step and copies over cleanly). Sleeps
  instead of starting when `TINYAUTH_APPURL` is unset (tinyauth refuses to boot without a
  real URL) — same opt-out idiom as `CADDY_ADAPTER_ENABLED`/`TAILSCALE_ENABLED`, and what
  keeps an unconfigured instance from crash-looping. Protects individual Dev Proxy routes
  that opt into "require auth" (Caddy `forward_auth` → tinyauth's `/api/auth/caddy` on
  `127.0.0.1:3000`) — a separate, lighter tool from webmanager's own `internal/authgate`,
  which stays exactly as-is, scoped only to webmanager's own Terminal/File Manager/Logs.
  `TINYAUTH_AUTH_USERS` (docker-compose env) is empty by default — no one can log in until
  set (`docker run --rm ghcr.io/tinyauthapp/tinyauth:v5 user create --username <u>
  --password <p> --docker` generates the value). The recommended path is now per-user
  add/delete via router-manager's own API/UI (`router/backend/internal/tinyauthusers`,
  a "설정" tab in router's own SPA — see "router-manager" below) instead of hand-editing
  that one env var — tinyauth itself only reads it at process start, so every add/delete
  restarts the `tinyauth` supervisord program via the same `restartSupervisorProgram`
  helper tailscale forwards/publish already use. `TINYAUTH_AUTH_USERS` still wins when
  actually set (an infra-as-code pin, same priority as `ROUTER_MANAGER_AUTH_PASSWORD_HASH`
  vs its own file-backed store) — the UI shows a read-only notice instead of an edit form
  in that case.

router-manager is router's own Go backend (`router/backend`, mirrors webmanager's own
backend pattern) — proxied in by code-docker's nginx (`config/nginx/nginx.default.conf`'s
`/tailscale/`/`/dev-proxy/`/`/router-auth/` locations, private-by-default — no
host-published port on router-manager itself): full tailscale CRUD (`GET`/`PUT
/api/tailscale/config`, `GET`/`POST`/`DELETE /api/tailscale/forwards[/{name}]`,
same for `/publish`, `GET /api/tailscale/status`, `POST /api/tailscale/login/
{start,cancel}`, plus the original read-only `GET /api/tailscale/state`
— `{backendState, authUrl}`, same shape the old status-polling script wrote —
code-server's sign-in banner, `config/code/code-patch/tailscale-notify.default.js`,
polls this now instead of a static file), the Dev Proxy expose CRUD webmanager's
Dev Proxy tab calls, and `POST /api/auth/unlock` + `GET /api/auth/status` for
router-manager's own admin-API password gate (see below). `/exports/` (actual
end-user traffic to an exposed dev server) is a separate nginx location from
`/dev-proxy/` (the admin API) — don't confuse the two.

router's own frontend (`router/frontend`, `@code-docker/router-frontend` — an npm workspace
package, root `package.json`'s `workspaces:`) owns the actual page components; webmanager's
`App.tsx` imports them directly (`import { DevProxy, Tailscale, RouterUnlockModalHost } from
'@code-docker/router-frontend'`) rather than owning that UI itself — see "webmanager" below and
`router/.claude/functional-router-plan.md`'s "router ↔ webmanager 프론트 통합 방식". Dev
Proxy, App Routes, and Tailscale (forwards/publish/login CRUD + status view) are all ported
this way; webmanager also leans on this package for generic, router-unrelated UI primitives
(`ErrorBanner`/`Sheet`/`Skeleton`), used across ~40 unrelated webmanager files — see
`.claude/backlog/router-frontend-decouple-plan.md` for why this workspace dependency can't be
dropped yet if `router`/`webmanager` ever split into separate repos. `router/frontend`'s own
`App.tsx` (a plain tab switcher, no react-router) is also
built into a real SPA now — `router/Dockerfile` has its own Node build stage (using
`router/frontend/package-lock.json`, generated standalone since this Dockerfile's build
context is `router/` only and can't reach the repo-root workspace lockfile) and
`router/backend/static.go` (ported from `webmanager/backend/static.go`) serves it directly
at `/router/`, replacing the old password-only `handlers_ui.go` page — so App
Routes/Dev Proxy/Tailscale/tinyauth users can all be managed without webmanager at all, only
router-manager's own API. First-run password setup/change now lives in this SPA too
(`RouterAuthPanel`, a React port of the old inline-JS page), under a "설정" tab alongside a
new `TinyauthUsers` panel (see below). `router/frontend/vite.config.ts`'s build `base` is
`'./'` (relative), not an absolute prefix like webmanager's own `'/manager/'` — this SPA is
served from two different depths depending on deployment (the shared hostname's `/router/`
path, or the root of a dedicated `ROUTER_MANAGER_HOSTS` domain, see below), and only a
relative base resolves correctly under both as long as the page itself is always linked with
a trailing slash. Confirmed live that an absolute `/` base 404s every asset under `/router/`,
since the browser resolves a root-absolute `src` against the origin root, bypassing the
`/router/` prefix entirely.

router-manager's own admin-API auth (`router/backend/internal/authgate`) is opt-in via
`ROUTER_MANAGER_AUTH_PASSWORD_HASH` and gates every *mutating* route above (tailscale
config/forwards/publish/login writes, dev-proxy expose writes) — reads (state, config,
list, status) stay open. The recommended path is setting a password in-app at
`/router/` instead of via env var, though — see docs/router.md's "router-manager 자체
인증" for the file-backed store (`ROUTER_VOLUME`), setup/change UI, and forgot-password
recovery; the env var remains as an infra-as-code pin that always wins over the
in-app-set one when present. A separate gate/cookie from webmanager's own
`internal/authgate` below (different process, different secret) — `router-manager
--hash-password` generates the argon2id hash. `RouterUnlockModalHost` (mounted in
webmanager's `App.tsx` next to its own `UnlockModalHost`) pops on any 401 from a gated
router-manager route, same "prompt → retry once" pattern webmanager's own gate uses. See
`router/plan.md` for the design history (this closed out the item that was previously
tracked there as "보류/미정").

The unlock cookie (`router_manager_unlock`) is host-only with no Domain attribute, and
`/router/` is reachable on the *shared* hostname by default (same origin as code-server/
webmanager/every `/exports/` and `/app/` target) — so a compromise anywhere on that shared
origin (XSS, a poisoned agent writing to the page) can ride the cookie into router-manager's
API via a same-origin `fetch()`; HttpOnly/SameSite=Strict only stop cross-origin/JS-read
access, not same-origin script. Router's own nginx strips the cookie from the proxied
`Cookie` header on `/exports/` and `/app/` (`router_manager_cookie_stripped` map in
`router/config/nginx/nginx.default.conf`) so an untrusted Dev Proxy/App Routes target can't
read it directly — but that doesn't close the same-origin-script vector. `ROUTER_MANAGER_HOSTS`
(`router/example-env.router`, comma-separated, default empty) is the actual fix: it adds a
second `server{}` block (env-only/restart-required, same trust tier as `ALLOWED_HOSTS`/
`ALLOWED_EXPORT_HOSTS` — never made in-app-editable) that serves router-manager's SPA+API
standalone on a dedicated hostname via nginx `server_name` matching, so its cookie is scoped
to that origin alone. `router/frontend`'s `RouterAuthPanel`/`RouterTrustedHostsPanel`/
`OriginWarningBanner` show the currently-configured value read-only and warn when accessed
over localhost or over the shared path despite a dedicated domain being configured — see
docs/router.md's "보안: 공유 origin과 전용 도메인" section.

`ROUTER_MANAGER_HOSTS` also changes how webmanager itself embeds the Dev Proxy/App
Routes/Tailscale tabs — see "webmanager" below and `webmanager/components/RouterEmbed/
RouterFrame.tsx` — switching from directly rendering `@code-docker/router-frontend`
components (same origin as webmanager, the pre-existing default) to a cross-origin
`<iframe>` into the dedicated domain, which is what actually closes the ambient-cookie gap
for those specific tabs: same-origin rendering means anything that compromises webmanager
itself already has DOM/cookie access into router-manager's calls, while a true cross-origin
iframe has none. `router/frontend/src/embedTheme.ts`'s `?theme=`/`postMessage` handling
(and the matching `[data-theme]` CSS blocks in `router/frontend/src/index.css`, mirroring
webmanager's own `theme.ts` idiom) keep the embedded iframe's light/dark choice in sync with
webmanager's, since a cross-origin iframe can't read the parent's `data-theme` attribute
directly the way a same-origin embed implicitly could.

router's own feature-specific env vars (tailscale, Dev Proxy exposure policy,
`ROUTER_MANAGER_AUTH_PASSWORD_HASH`, tinyauth, `/exports/` allowlists — everything above
that isn't shared with code-docker or tied to compose topology) live in
`router/example-env.router` (copy to `router/.env.router`), not the repo-root
`example-env` — mirrors webmanager's `.env.webmanager` pattern, including a
`router-manager --env-migrate` CLI and startup version-mismatch warning
(`ROUTER_ENV_VERSION`/`ROUTER_ENV_TEMPLATE_PATH`). The migration logic itself
(reconcile-against-template, `#!important`/`#!` markers, `#~` dead-key archival) is a
shared root-level Go module, `envmigrate/` — extracted from webmanager's own
`internal/envmigrate` and parameterized (version-key name, file names) so both tools use
it. webmanager's Dockerfile stage just adds one `COPY envmigrate/` (its build context is
already repo root); router/backend's build context is deliberately isolated to `router/`
(see `router/CLAUDE.md`), so it can't reach a repo-root module directly — `go mod
vendor` materializes `envmigrate/` into `router/backend/vendor/` instead, which *is*
inside router's own build context and gets committed like any other source. Run
`vendor-envmigrate.sh` (repo root) after editing `envmigrate/` and before rebuilding
router's image — `go build` fails loudly on a stale/inconsistent `vendor/`, so this
can't silently drift. `ROUTER_HOSTNAME` (default `router`) is a similar
compose-topology-vs-feature-var split example in the other direction: it stays in the
repo-root `example-env` (not `router/example-env.router`) because code-docker,
code-docker-netinit, and code-docker-dind all resolve it too (`getent hosts
"$ROUTER_HOSTNAME"` in their own entrypoint scripts) and code-docker-router's own network
alias must stay in sync with the same value.

`config/code/code-patch/` is a generic mechanism, not tailscale-specific: any `<name>.default.<ext>` there (with an optional matching gitignored `<name>.override.<ext>`) gets seeded by `code-patch.default.sh` into `/code/.local/share/code-docker/code/patch/<name>.<ext>` — code-server-autoinstall auto-injects every top-level `patch/*.js` as a `<script>` tag on every start (see "코드 서버 패치" in README). Re-seeded on *every* boot, but only when the live target's content still hashes to what was seeded last time (`/code/.local/share/code-docker/code/.code-patch-manifest` now tracks `<name>\t<hash>` pairs, not just names) — i.e. a bundled `.default.`/`.override.` fix actually reaches an already-running container instead of the old "only copy if missing" behavior silently freezing the target at whatever was first seeded forever. If the live file's hash doesn't match (user edited it directly, or there's no recorded hash yet — e.g. a target that predates this hash-tracking), it's left alone; a `.default.` file removed in a later code-docker version still gets its old target removed too instead of orphaned forever. Because there's no historical hash for anything seeded before this behavior shipped, upgrading alone won't retroactively re-apply a fixed default to an already-seeded file that was never otherwise touched — delete the file under `/code/.local/share/code-docker/code/patch/` once to force a fresh reseed with hash-tracking from then on. `code-patch.default.sh` is invoked from `code-service.default.sh` (not `user-init.default.sh` — that one's scoped to home-folder/shell setup like fish config, not code-server internals), deliberately *after* `install.sh` so `/code/.local/share/code-docker/code` actually exists by the time it runs.

### webmanager

A browser admin panel (Go backend + Vite/React frontend, `webmanager/` — its own subtree, with its own `CLAUDE.md`/`plan.md`) running alongside code-server as another supervisord program, on port 81. Well beyond its original scope now: supervisord process management, SSH `authorized_keys`/`known_hosts`, git config (commit signing/GPG, git-lfs, raw `.gitconfig` editing), the vector-backed logs pipeline described above, an OS-level process/port viewer with resource-history graphs, a Projects-folder browser with a per-project git status panel, code-server extension and mise tool management, a Claude Code status tab, Docker/dind management, a Dev Proxy tab (imported from `@code-docker/router-frontend` — see "router" above, the actual Caddy instance/backend live on the router container, not here), a web terminal (ephemeral PTY sessions), and a full file manager — see `webmanager/plan.md` for the up-to-date implemented/TODO split. Most of it still has no login of its own and relies entirely on the same reverse-proxy forward-auth as code-server; an opt-in shared password gate (`internal/authgate`, off by default) additionally protects the Terminal/File Manager tabs entirely and gates write actions elsewhere (see `webmanager/.claude/archive/authgate-plan-done.md`) — note this gate no longer covers Dev Proxy or Tailscale at all; both moved to router-manager's own API and are gated by router-manager's own separate `internal/authgate` instance instead (`ROUTER_MANAGER_AUTH_PASSWORD_HASH` — see "router" above).

## Documentation

`README.md` is now just a short intro (screenshot + one paragraph + a pointer into `docs/`) — as of 2026-08-05 the actual user-facing content that used to live there (setup, the override customization system mirroring the "override pattern" above but from a user's perspective, and a "tips" section per integration: ssh, adb, Discord presence, dind, clipboard, multi-instance via `PREFIX`) moved to `docs/index.md`, with per-topic detail pages alongside it (`docs/build-customization.md`, `docs/router.md` (the router container's own doc — tailscale/Dev Proxy/tinyauth), `docs/tailscale.md` (now just a short pointer into `docs/router.md`), `docs/dev-proxy.md`, `docs/egress-netgate.md`, `docs/webmanager.md`, `docs/webmanager-config.md`, `docs/security-login.md`, `docs/code-server-patch.md`, `docs/tips/*.md`). This was done anticipating that `docs/` gets bundled/rendered inside webmanager itself someday (see `webmanager/.claude/research/guide-plan.md`) — keeping it as its own directory rather than scattered across the repo root makes that easier. When adding a new customizable file or a new environment trick, add a matching entry to `docs/index.md` (or the relevant `docs/*.md` page) in the same style as the existing ones — not `README.md`. A revamp plan for the now-short `README.md` itself (badges, a tighter intro) is tracked in `.claude/backlog/readme-revamp-plan.md`.
