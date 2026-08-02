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

## Architecture

### The override pattern

Nearly every runtime behavior is defined by a pair of files under `config/`: `<name>.default.*` (checked into git) and an optional `<name>.override.*` (gitignored, user-provided). A `script/<name>.sh` dispatcher execs the override if present, else the default — e.g. `script/code-service.sh` → `config/code-service.default.sh` or `config/code-service.override.sh`. This same pattern applies to `build`, `code-service`, `sshd-service`, `supervisord.conf`, `shell`, and `user-init`. When adding a new customizable behavior, follow this pattern rather than hardcoding logic into the Dockerfile.

`.sh` override files must be `chmod u+x`. Editing an override requires a rebuild (`docker compose build && up`), not just a container restart.

### Process model

`entrypoint.sh` starts `supervisord` (config: `config/supervisord.default.conf`), which runs `code-service` and `sshd` as managed programs, plus anything dropped into `config/supervisord/*.conf` (gitignored, auto-`include`d). The `restart` command (in `bin/`, on `PATH`) does `supervisorctl restart code-server` — this is how users pick up `mise`-installed toolchain changes or patch edits without a full container rebuild.

- `code-service.default.sh` runs user-init (if `/code/.installed` doesn't exist yet), then delegates to `code-server-autoinstall/start.sh` via `code-runner.default.sh` (which first does `mise env --shell bash` so mise-installed tools are on `PATH` for the service, not just interactive shells).
- `user-init.default.sh` runs on **every** boot (not just first-time) so it can carry out home-folder migrations; it tracks a version number in `/code/.installed` and only re-runs the first-time setup (fish shell config, qwreey-fish) once.
- `sshd-service.default.sh` inits `/etc/ssh` from `/etc/default/ssh` (baked in at build time from Arch's default config) on first run, then execs `sshd -D`.

### Build (Dockerfile)

Multi-stage: `docker:latest` is used only as a source to `COPY --from=docker-bin` the standalone `docker` CLI binary into the Arch image (`/usr/bin/docker`) — this avoids installing the full `docker`/`dockerd` package via pacman just to get the client. `docker-compose` and `docker-buildx` (CLI plugins, `docker` is only an optional dependency for both on Arch) are instead installed normally via pacman in `config/build.default.sh`, alongside `yay` (AUR helper, bootstrapped by `script/install-yay.sh` for anything not in the official repos).

`bin/` is copied to `/usr/local/bin/`, so it's on `PATH` everywhere in the container (not just inside code-server's integrated terminal). Notable entries: `restart` (see above), `code`/`copy` (thin wrappers around the vendored `code-server` CLI, which is actually a symlink to VS Code's `remote-cli` script), and `xclip`/`wl-copy` shims that forward stdin to `code-server -c` (the CLI's `--stdin-to-clipboard` flag) so clipboard tools inside the browser-based terminal work despite OSC 52 not being supported.

### docker-compose topology

Two user-defined networks: `code-docker-external` (has internet/host access) and `code-docker-internal` (`internal: true`, no outside route). `code-docker` sits on both; `code-docker-dind` (the `docker:dind` sidecar, used so `docker`/`docker compose`/`docker buildx` work *inside* code-docker via `DOCKER_HOST=tcp://code-docker-dind-internal:2375`) is also on both — it needs `code-docker-external` for `docker pull` to work, since `internal: true` networks have no route out. All service/network names are prefixed with `${PREFIX:-}` to let multiple instances coexist on one host without name collisions (set `PREFIX` in `.env`).

`code-docker-dind` doesn't use the stock `docker:dind` entrypoint directly — `script/dind-entrypoint.sh` is bind-mounted in and set as `entrypoint:` so the daemon binds only to its `code-docker-internal` IP instead of the image's hardcoded `0.0.0.0:2375` (it picks that IP dynamically at startup, by finding the interface with no default route — `code-docker-internal` being the only network without one — rather than hardcoding an address). This keeps the daemon's unauthenticated socket unreachable from `code-docker-external` even though that network is attached (for `docker pull`).

**Always address `code-docker-dind` via the `code-docker-dind-internal` alias, never the bare service name.** `code-docker` sits on both networks, so the bare name `code-docker-dind` is registered in both networks' DNS zones and resolves ambiguously/inconsistently (a known Docker embedded-DNS limitation for multi-homed containers) — and since the daemon only listens on its internal IP, resolving to the external one just fails to connect. `code-docker-dind-internal` is a network-scoped alias defined only on `code-docker-internal` (see `networks.code-docker-dind.code-docker-internal.aliases` in docker-compose.yml), so it can't resolve to the wrong side. Use it for `DOCKER_HOST` and for reaching any port published by a container created inside dind.

**Security-relevant, intentional trade-offs** (documented in README, keep in sync when touching these):
- `code-config.default.yaml` sets `auth: none` — code-server itself has no login; a reverse proxy with forward-auth (e.g. Caddy + Authentik) is expected in front of it.
- `code-docker-dind` runs `privileged: true` with an unauthenticated, TLS-less daemon socket (`DOCKER_TLS_CERTDIR: ""`). Thanks to `dind-entrypoint.sh` it's only reachable from `code-docker-internal`, not `code-docker-external` — but anyone who can reach `code-docker-internal` still gets host-kernel-equivalent access. Data persists via `./dind:/var/lib/docker`.
- `cap_add: SYS_PTRACE` (debuggers like gdb/btop that trace other processes) and `IPC_LOCK` (avoids IPC-related perf bottlenecks — IDEs/LSPs do a lot of IPC) are added by default.
- Containers created *inside* `code-docker-dind` (e.g. `docker run postgres` from within code-docker) live in the inner daemon's own private network — they are **not** reachable by name on `code-docker-internal`; reach them via `code-docker-dind-internal:<published-port>`. This is inherent to nested Docker-in-Docker (separate daemon, separate netns/network store) and was deliberately not "fixed" by switching to Docker-outside-of-Docker (host socket mount), since that would remove the one layer of isolation the nested daemon currently provides.

### In-progress design work

`tailscale.md` at the repo root holds work-in-progress design notes (not yet implemented) for giving `code-docker` a Tailscale identity via **userspace networking** (deliberately avoiding `NET_ADMIN`/`/dev/net/tun`) plus a `socat`+SOCKS5-based dynamic port-forwarding setup, configured through a YAML file under the already-persistent `/code` volume. Read it before touching anything Tailscale-related. Once implemented, it needs a matching "tips" section added to `README.md` following the style of the existing ssh/adb/Discord/dind sections.

## Documentation

`README.md` (Korean) is the user-facing doc — setup, the override customization system (mirrors the "override pattern" above but from a user's perspective), and a "tips" section per integration (ssh, adb, Discord presence, dind, clipboard, multi-instance via `PREFIX`). When adding a new customizable file or a new environment trick, add a matching entry there in the same style as the existing ones.
