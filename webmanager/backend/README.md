# webmanager backend

Go backend for the webmanager admin panel. Implements supervisord process
management (over the existing `/run/supervisor.sock` XML-RPC socket), SSH
`authorized_keys` management, git configuration (user.name/email, SSH host
keys, HTTPS credential store, commit signing + GPG key management), a
cross-service logs API backed by the `vector` JSONL pipeline, an OS-level
process/port viewer (`github.com/shirou/gopsutil/v4`) for finding and
killing stray processes squatting on a port, a whole-container cpu/mem/disk
resource endpoint read directly from this container's own cgroup v2
pseudo-files (see `internal/cgroup`), and a read-only Claude Code status
overview (login state + local usage stats, see `internal/claudecode`). See
`../plan.md` for the wider design context and the full up-to-date feature
list — tailscale and Dev Proxy were moved out to the separate `router/`
container/backend and are not implemented here.

## Build

```sh
go build -o webmanager .
```

## CLI

The same binary doubles as a one-off CLI helper, checked before any server
startup logic in `main()`:

```sh
webmanager --hash-password
```

Computes an argon2id hash for `WEBMANAGER_AUTH_PASSWORD_HASH`
(`internal/authgate.HashPassword`) and exits — never starts the HTTP server.
Prompts twice with echo disabled when stdin is a real terminal (typo check);
reads a single line otherwise (piped/scripted input). Only the finished hash
goes to stdout, everything else (prompts, errors) goes to stderr, so
`HASH=$(webmanager --hash-password <<< "$pw")` works. See root
`docker-compose.yml`'s `WEBMANAGER_AUTH_PASSWORD_HASH` comment for the exact
`docker compose exec` invocation this is meant to be run with in the real
container.

```sh
webmanager --env-migrate
```

Reads a `.env.webmanager` from stdin, reconciles it against
`WEBMANAGER_ENV_TEMPLATE_PATH`'s current `example-env.webmanager`
(`internal/envmigrate.Migrate`), and writes the reconstructed file to
stdout — never starts the HTTP server. Migration notes (`INFO`/`WARN`) go to
stderr, so `cat .env.webmanager | webmanager --env-migrate >
.env.webmanager.new` works. See `internal/envmigrate`'s package doc and
`webmanager/.claude/env-migration-plan.md` for the full merge behavior
(preserved user values/comments, `#!important`-forced keys, `#!`-flagged
conflict markers, the `#~` dead-key archive).

## Run locally

None of the default paths (`/run/supervisor.sock`, `/code/.ssh/...`, etc.)
exist outside the target container, so for local dev point every path at
scratch locations and use a non-privileged port:

```sh
WEBMANAGER_ADDR=:8081 \
SUPERVISOR_SOCK=/tmp/supervisor.sock \
SSH_AUTHORIZED_KEYS=/tmp/wm-dev/authorized_keys \
GIT_CONFIG_PATH=/tmp/wm-dev/gitconfig \
SSH_CLIENT_CONFIG=/tmp/wm-dev/ssh-config \
SSH_KEYS_DIR=/tmp/wm-dev/ssh-keys \
GIT_CREDENTIALS_PATH=/tmp/wm-dev/git-credentials \
SSH_SIGNING_KEY_PATH=/tmp/wm-dev/signing_key \
VECTOR_LOG_DIR=/tmp/wm-dev/vector-logs \
SYSTEM_DISK_PATH=/tmp \
CLAUDE_CONFIG_DIR=/tmp/wm-dev/claude \
./webmanager
```

Without a real supervisord socket at `SUPERVISOR_SOCK`, the `/api/supervisor/*`
endpoints will return `502` (the RPC call fails to connect) — the SSH key and
git config endpoints work standalone since they only touch the filesystem and
shell out to `git`/`ssh-keygen`.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `WEBMANAGER_ADDR` | `:81` | HTTP listen address |
| `SUPERVISOR_SOCK` | `/run/supervisor.sock` | supervisord XML-RPC unix socket |
| `SSH_AUTHORIZED_KEYS` | `/code/.ssh/authorized_keys` | authorized_keys file |
| `GIT_CONFIG_PATH` | `/code/.gitconfig` | global gitconfig file |
| `SSH_CLIENT_CONFIG` | `/code/.ssh/config` | ssh client config (Host blocks) |
| `SSH_KEYS_DIR` | `/code/.ssh/keys` | generated per-host ed25519 keypairs |
| `GIT_CREDENTIALS_PATH` | `/code/.git-credentials` | HTTPS credential store file |
| `SSH_SIGNING_KEY_PATH` | `/code/.ssh/signing_key` | dedicated ed25519 keypair generated for git SSH commit signing |
| `VECTOR_LOG_DIR` | `/code/.local/share/code-docker/vector/logs` | directory of day-partitioned `<YYYY-MM-DD>.jsonl` log files written by the `vector` pipeline (see `.claude/archive/vector-logs-plan-done.md`) |
| `SYSTEM_DISK_PATH` | `/code` | path `GET /api/system/resources` runs `statfs` on to report disk usage — `/code` is the bind-mounted volume (`./data/code:/code`), so this reflects real host disk usage for that mount |
| `SYSTEM_DISK_BREAKDOWN_ROOT` | `/` | root path `GET /api/system/disk-breakdown` breaks down by top-level directory (see `internal/diskusage`) — deliberately `/` (the container's own root filesystem), not `SYSTEM_DISK_PATH` |
| `WEBMANAGER_DISK_BREAKDOWN_CACHE_PATH` | `/code/.local/share/code-docker/webmanager/disk-breakdown-cache.json` | cache file for the disk breakdown scan (only recomputed on `POST .../scan`, same convention as `WEBMANAGER_PROJECTS_CACHE_PATH`) |
| `WEBMANAGER_STATIC_DIR` | `./static` | pre-built frontend assets (see below) |
| `WEBMANAGER_CLAUDE_BINPATH` | *(none)* | absolute path to the `claude` (Claude Code CLI) binary; if unset, falls back to a `claude` lookup on `PATH`. Neither found means "not installed" — a normal state, not an error |
| `CLAUDE_CONFIG_DIR` | `/code/.claude` | Claude Code's own standard env var for relocating `~/.claude`; webmanager reads `stats-cache.json` from directly under this directory and does not invent a separate `WEBMANAGER_`-prefixed equivalent |
| `WEBMANAGER_CLAUDE_PREFS_PATH` | `/code/.local/share/code-docker/webmanager/claude-prefs.json` | persisted `{hideVersionCheck}` toggle for the Claude tab's mise version-check banner (`internal/claudecode/prefs.go`) |
| `WEBMANAGER_ENV_TEMPLATE_PATH` | `/etc/code-docker/webmanager/example-env.webmanager` | the `example-env.webmanager` template `--env-migrate` and the startup version check read — deliberately not `go:embed`'d so an operator running multiple instances can bind-mount their own org-customized template over this path instead of rebuilding the image. Set via `docker-compose.yml`, not `.env.webmanager` itself (see its comment there for why) |
| `WEBMANAGER_ENV_VERSION` | *(none)* | `.env.webmanager`'s own `WEBMANAGER_ENV_VERSION` (set via `env_file`, not meant to be hand-edited — `--env-migrate` manages it). Compared at startup against the template's current version; a mismatch logs a warning and is surfaced by `GET /api/system/env-version` |
| `WEBMANAGER_ENV_VERSION_DISMISS_PATH` | `/code/.local/share/code-docker/webmanager/env-version-dismiss.json` | persisted "user has acknowledged this version's mismatch banner" flag (`internal/envversionprefs`) |

GPG-backed endpoints (`/api/git/gpg-keys*`) additionally depend on the `gpg`
binary being on `PATH` (installed via `gnupg` in `config/build/build.default.sh`);
if it isn't found, those endpoints return `501` instead of failing outright.

## Frontend integration

`WEBMANAGER_STATIC_DIR` is where the separately-built frontend's `dist/`
output gets pointed once the frontend exists — this directory doesn't need
to exist for the backend to run (any request falls through to a plain 404).
Any non-`/api` GET request is served from that directory, falling back to
`index.html` for SPA client-side routing when the requested path isn't a
real file.

## API contract

Implemented per `../plan.md`'s MVP scope plus the second implementation
round (git commit signing/GPG, logs API):

Every request body is capped at 1 MiB (`http.MaxBytesReader`, applied
uniformly via a small middleware in `main.go`) — exceeding it fails the
`json.Decode` call, which every handler already maps to a plain `400`.

"Already exists" conflicts (SSH host, SSH key) are `409 Conflict`,
consistent with the supervisor package's
`ALREADY_STARTED`/`NOT_RUNNING` faults; malformed-input `400`s (missing
fields, invalid host/keyId format, etc.) are unaffected.

- `GET /api/supervisor/processes`
- `POST /api/supervisor/processes/{name}/start|stop|restart`
- `GET /api/supervisor/processes/{name}/log?stream=stdout|stderr&tail=N`
- `GET/POST /api/ssh/keys`, `DELETE /api/ssh/keys/{id}` — `409` if the key
  (by fingerprint) already exists, `400` for a malformed key
- `GET/PUT /api/git/config`
- `GET/POST /api/git/ssh-hosts`, `DELETE /api/git/ssh-hosts/{host}` — `host`
  must match `^[A-Za-z0-9._-]+$` (it's used as both a filesystem path
  component under `SSH_KEYS_DIR` and an SSH config alias), `hostname`/`user`
  must not contain `\r`/`\n` (prevents SSH-config-line injection); any of
  these being invalid is `400`, an already-existing `host` is `409`. If the
  key is generated but the subsequent config-file write fails, the orphaned
  key files are removed automatically before the error is returned.
- `GET/POST /api/git/credentials`, `DELETE /api/git/credentials/{host}`
- `GET/PUT /api/git/signing` — commit signing mode (`none`/`ssh`/`gpg`),
  signing key, `commit.gpgsign`
- `POST /api/git/signing/ssh-key` — (re)generates the dedicated SSH signing
  keypair at `SSH_SIGNING_KEY_PATH`, returns its public key; does not itself
  change `/api/git/signing`
- `GET/POST /api/git/gpg-keys`, `GET /api/git/gpg-keys/{keyId}/public`,
  `DELETE /api/git/gpg-keys/{keyId}` — minimal GPG key management (`keyId` is
  the full 40-hex fingerprint, validated with a `^[0-9A-Fa-f]{40}$` check
  before it's ever passed to `gpg` — anything else is `400`, closing off
  gpg-flag injection via a value like `--homedir=...`); `501` if `gpg` isn't
  installed
- `GET /api/logs/apps` — real supervisord process names, `{"mock": false}`
- `GET /api/logs/entries?app=&level=&limit=` — real log entries read from
  the `vector`-produced JSONL files at `VECTOR_LOG_DIR` (see
  `internal/logstore` and `.claude/archive/vector-logs-plan-done.md` for the on-disk contract);
  `app`/`level` are exact-match filters (case-sensitive, both optional),
  results are sorted by timestamp descending, `limit` defaults to 100 (max
  1000, `400` if not a positive integer), `level` must be `info`/`warn`/
  `error` if given (`400` otherwise). Only the two most recent day-files
  (today + yesterday, by *UTC* calendar date — matching vector's own
  UTC-keyed `%Y-%m-%d.jsonl` file-sink path, so this doesn't drift for
  several hours around local midnight if the container's `TZ` is ever set
  to a non-UTC zone) are read rather than globbing every file ever
  produced, to keep I/O bounded in a long-lived container. A missing
  `VECTOR_LOG_DIR`, missing day-files, malformed individual lines (partial
  writes mid-append), or even a single oversized line (over the 1MiB
  scanner buffer) are all handled gracefully — a file with an oversized
  line yields whatever entries were read before it (lines after it in that
  same file are unrecoverable, since a `bufio.Scanner` can't resync
  mid-token, but that's the only degradation: other files/days are
  unaffected) — never a `5xx`. `mock` is always `false`, including when the
  result is empty (there's just nothing real to show yet, as opposed to
  fake data)
- `GET /api/processes` — OS process list (pid/ppid/name/username/status/
  cpuPercent/memPercent/rssBytes/cmdline), sorted by `cpuPercent` descending.
  `cpuPercent` is computed server-side from two time-separated CPU-time
  samples (delta since this endpoint's last call, normalized by core count
  into a 0-100 range) — the same technique `top`/`htop`/`btop` use; the
  first time a given pid is observed it reports `0`. Per-process lookup
  failures (process exits mid-scan) silently drop that process from the
  result; a `username` lookup failure alone just leaves that field empty
  instead
- `GET /api/ports` — listening TCP sockets + all UDP sockets (`ss -tulnp`
  equivalent): protocol/localAddress/localPort/pid/processName. `pid: 0`/
  `processName: ""` when the owner can't be resolved
- `POST /api/processes/{pid}/signal` — body `{"signal": "TERM"|"KILL"}`,
  sends the signal via `syscall.Kill`; `404` if no such process, `403` if
  not permitted, `400` for an invalid pid/signal value
- `GET /api/system/resources` — whole-container cpu/mem/disk usage read
  directly from this container's own cgroup v2 pseudo-files (see
  `internal/cgroup`; no docker.sock or host access needed, a container can
  always read its own cgroup). This is the number `docker stats` would show
  on the host, which `btop` run inside the container can't see (it only
  sums the container's own process list, not the cgroup accounting):
  - `memory.usedBytes`/`memory.limitBytes` from `memory.current`/
    `memory.max` (`limitBytes` is `null` when the cgroup has no memory
    limit, i.e. `memory.max` reads the literal `"max"` — the case in
    practice right now since `docker-compose.yml` sets no `mem_limit`)
  - `cpu.percent` is delta-sampled from `cpu.stat`'s `usage_usec` between
    two calls to this endpoint (same technique as `/api/processes`'
    `cpuPercent`, held in a `cgroup.Sampler` field on `Server` so the
    previous sample survives across requests); the first call ever made
    reports `0`. Normalized against the cgroup's own `cpu.max` quota when
    one is set (100% = fully using the quota, matching `docker stats`), or
    against total system capacity (`numCpu` cores) when unlimited — same
    convention `/api/processes`' `cpuPercent` already uses per-process, so
    an unlimited container isn't held to some other implicit scale
  - `cpu.limitCores`/`cpu.numCpu` from `cpu.max` (`null` if unlimited,
    otherwise `quota/period`) and `runtime.NumCPU()` respectively; `numCpu`
    is unrelated to any cgroup quota, included so the frontend can show
    "X / Y cores" context even without a limit set
  - `disk` is `syscall.Statfs` on `SYSTEM_DISK_PATH` (default `/code`, the
    bind-mounted volume) — `usedBytes`/`freeBytes` follow `df`'s own
    convention (`Blocks-Bfree` / `Bavail`), so they don't sum exactly to
    `totalBytes` (the gap is the filesystem's reserved-for-root margin)
  - Each of memory/cpu/disk carries its own `available: bool` field — `true`
    when that section's cgroup/statfs read succeeded, `false` when it
    degraded to zeroed fields — so a caller can distinguish "this section
    is genuinely `0`" from "this section's real value is unknown" (which a
    bare `0`/`null` can't express on its own). Purely additive: every other
    field keeps its exact prior name/type/meaning.
  - Each of memory/cpu/disk degrades independently: an unreadable or
    unexpected-format cgroup file (non-v2 host, permission issue, etc.)
    zeros/nulls just that section (and sets its `available: false`) rather
    than failing the request; only if literally none of the three could be
    read does this return `503 {"error": "cgroup v2 data unavailable"}` as
    a last resort. cgroup v1 is
    not supported (reads simply fail there, degrading as above)
- `GET /api/system/disk-breakdown` — cached per-top-level-directory disk
  breakdown of the container's own root filesystem (`SYSTEM_DISK_BREAKDOWN_ROOT`,
  default `/`) — a Storage-Sense/Samsung-저장공간-분석기-style "what's using
  space where" view, distinct from `GET /api/system/resources`'s single
  statfs number for `SYSTEM_DISK_PATH`. Always returns instantly (the cached
  result, `internal/diskusage`) — never runs `du` on a plain GET.
  `root`/`available`/`scanning`/`scannedAt`/`totalBytes`(statfs)/`freeBytes`/
  `entries: [{name, path, sizeBytes}]`. Virtual/RAM-backed filesystems
  (`proc`, `sysfs`, `tmpfs`, ...) are excluded via `/proc/mounts` fstype
  matching; symlinked top-level dirs (e.g. Arch's usr-merge `/bin` →
  `/usr/bin`) report only their own tiny symlink size, not their target's
  content (GNU `du`'s own default behavior for a symlink given as a
  command-line argument — verified, not something this endpoint special-cases)
- `POST /api/system/disk-breakdown/scan` — triggers a fresh scan in the
  background (`du -sb` per top-level directory) and returns the current
  snapshot immediately (`scanning: true` while it runs); a scan already in
  flight makes this a no-op. Same cache-then-explicit-trigger convention as
  `POST /api/projects/scan` — a full root-filesystem `du` can take a while,
  so it never runs implicitly
- `GET /api/claude/status` — read-only Claude Code (the `claude` CLI) quick
  overview: `installed` (binary found via `WEBMANAGER_CLAUDE_BINPATH` or
  `PATH`), `auth` (from `claude auth status --json`, run with a 5s timeout
  since it may involve a network round-trip), and `stats` (parsed from
  `<CLAUDE_CONFIG_DIR>/stats-cache.json`). This is always `200` in practice —
  every sub-fetch degrades independently to a `null` field rather than
  failing the request:
  - `installed: false` → `auth`/`stats` are `null`, nothing else is
    attempted (a `claude`-less instance is a normal, common case)
  - `installed: true` but the CLI call fails/times out/produces unparseable
    JSON → `auth: null`
  - `stats-cache.json` missing or unparseable → `stats: null`, independent
    of whatever happened with `auth` (a logged-out instance can still have
    historical stats on disk)
  - `stats.today`/`stats.week` are derived from `stats-cache.json`'s
    `dailyActivity` array: `today` matches today's UTC calendar date
    (`{sessionCount: 0, messageCount: 0}` if no entry exists for it, not an
    error), `week` sums the 7 most recent dates present in the array
    (descending, today's entry included if present) — there's no
    pre-computed weekly field in the cache file itself
  - Verified against the real `claude` 2.1.220 CLI: explicitly setting
    `CLAUDE_CONFIG_DIR` in the environment (even to the exact path it would
    have defaulted to) makes `claude auth status --json` itself null out
    `email`/`orgId`/`orgName` while `loggedIn`/`authMethod`/
    `subscriptionType` stay correct — a pre-existing CLI quirk, not
    something this endpoint's wrapper introduces or can paper over
  - `miseVersion` (`{current, latest, outdated}` or `null`) — present only
    when `claude-code` shows up in `mise ls -g --json`'s output (i.e. it's
    actually managed by mise's *global* config, not just present on `PATH`
    some other way); `latest` comes from `mise latest claude-code`. Any
    failure anywhere in that chain (mise itself missing, tool not in the
    global list, the latest-lookup failing) just leaves this `null`
- `GET /api/claude/plugins` — installed Claude Code skills/plugins
  (`claude plugin list --json`), read-only; degrades to `{"plugins": []}` on
  any failure rather than a `5xx`
- `POST /api/claude/install` *(gated)* — installs (or updates, since it
  always re-resolves and installs the latest version — there's no v1 need to
  pin an older one) Claude Code through mise: resolves `mise latest
  claude-code` to a concrete version first (never passes the literal string
  `"latest"` through to `mise use`), then reuses the exact same
  `mise.JobStore` the mise tab's own install flow uses. Returns `{"jobId":
  "..."}` — poll the existing `GET /api/mise/jobs/{id}` to track it, no
  separate polling endpoint was added
- `GET /api/claude/prefs` / `PUT /api/claude/prefs` *(PUT gated)* —
  `{"hideVersionCheck": bool}`, backend-persisted (`internal/claudecode/prefs.go`,
  `WEBMANAGER_CLAUDE_PREFS_PATH`) rather than `localStorage`, since unlike the
  mise tab's show/hide toggles this is meant to follow the user across
  browsers/devices
- `POST /api/claude/login/start` *(gated)* → `{"sessionId": "..."}` — starts a
  managed `claude auth login` background subprocess (`internal/claudecode/login.go`'s
  `LoginManager`; only one session is ever tracked at a time, a fresh `Start`
  kills whatever was running before). Plain `os/exec` pipes are used for
  stdin/stdout/stderr — empirically confirmed sufficient, no PTY needed, since
  the CLI already falls back to a paste-a-code flow when it can't reach its
  local OAuth callback (the normal case in a container)
- `GET /api/claude/login/{id}` *(gated)* → `{"running": bool, "lines":
  [...], "url": "...", "exitCode": int|null}` — `url` is extracted from the
  process's output via a bare `https://\S+` regex once the CLI prints its
  sign-in link; `404` if `id` doesn't match the current session (superseded
  or never existed) — the frontend should treat that as "start over," not
  retry
- `POST /api/claude/login/{id}/code` *(gated)*, body `{"code": "..."}` →
  `{"ok": true}` — relays a user-pasted sign-in code to the subprocess's
  stdin
- `POST /api/claude/login/{id}/cancel` *(gated)* → always `{"ok": true}`,
  idempotent — kills the session if it's still current, a harmless no-op
  otherwise (frontend calls this best-effort on unmount)

Tailscale (config CRUD, status, login) and Dev Proxy both used to be
implemented here — see `router/backend/handlers_tailscale.go`/
`handlers_devproxy.go` and `router/CLAUDE.md`, now served by router-manager
instead.

- `GET /api/dind/containers` — every container in the `code-docker-dind`
  sidecar (running and stopped, `docker ps -a` equivalent):
  id/names/image/command/state/status/ports/created, all straight from
  `docker ps --format json` (one JSON object per line, native — not a Go
  template). Ungated (read-only) — see `internal/dind` for why shelling out
  to the `docker` CLI (already on `PATH`, `DOCKER_HOST` already points at the
  dind sidecar) was chosen over the official SDK
- `GET /api/dind/images` — every image in the dind sidecar:
  id/repository/tag/size/created, from `docker images --format json`
- `GET /api/dind/containers/{id}/logs?tail=N&since=<unix-seconds>` — combined
  stdout+stderr, timestamped, via `docker logs`. `tail` defaults to 1000
  lines. `since` (optional) is a bare unix-seconds timestamp — passing the
  last-seen line's time lets the frontend poll for only what's new instead
  of re-fetching a growing tail; no persistent `--follow` subprocess is kept
  running (a fresh short-lived `docker logs` process per poll instead, for a
  simpler cancellation/lifecycle story). `404` if no such container, `400`
  if `id`/`tail`/`since` fails validation
  - v1 is deliberately read-only: no start/stop/remove yet (queued next),
    and `docker run`/`exec`/`cp` are out of scope indefinitely — see
    `webmanager/.claude/dind-plan.md`

- `GET /api/terminal` — WebSocket upgrade, opens the container's login shell
  in a PTY (binary frames = PTY input/output, text frames = `{"type":
  "resize", cols, rows}`). Gated by the shared password gate like everything
  else terminal-related. Two paths, kept fully separate in the handler:
  - **without** `?session=<name>` — M1's original ephemeral behavior: a
    brand new PTY every connection, killed (SIGHUP, then SIGKILL after a
    grace period) the moment this connection closes. No persistence.
  - **with** `?session=<name>` (M2) — reattaches to (or creates)
    a named session via `internal/termsession`: the PTY survives this
    connection closing, and a later connection with the same name replays
    recent scrollback before switching to the live stream. A second
    connection to the same name kicks the first (last-connection-wins, not
    concurrent shared viewing). `400` for an invalid name (1-64 chars,
    letters/digits/spaces/`_`/`-`/`.`)
- `GET /api/terminal/settings` / `PUT /api/terminal/settings` — persisted
  keybindings/theme (`internal/terminalsettings`), gated
- `GET /api/terminal/sessions` — every known M2 session:
  `{name, pinned, createdAt, lastAttachedAt, attached}[]`, sorted oldest
  first. A session only appears here once it's actually been connected to at
  least once (creation is lazy, triggered by the WS handshake above, not a
  separate call)
- `PATCH /api/terminal/sessions/{name}` — body `{"pinned": bool}`. Pinned
  sessions are exempt from idle cleanup (`WEBMANAGER_TERMINAL_SESSION_
  IDLE_TIMEOUT`, default 30m — unpinned sessions with no attached client
  past this are reaped); this is the only difference pinning makes, session
  creation itself never asks for it up front (see
  `webmanager/.claude/archive/terminal-plan-done.md`'s "영속 세션 토글" for why). `404` if
  unknown
- `DELETE /api/terminal/sessions/{name}` — kills the session immediately
  regardless of pinned state. `404` if unknown

- `GET /api/auth/status` — `{required, unlocked, unlockedUntil?}`.
  `unlockedUntil` (RFC3339) is only present when `unlocked` is true — lets
  the sidebar show a "N분 남음" countdown instead of a bare bool
  (`internal/authgate.Gate.UnlockedUntil`). Never gated (a locked-out client
  has to be able to check this).
- `POST /api/auth/unlock` — body `{"password": string}`. `401` on a wrong
  password. Never gated, same reason as above.

- `GET /api/system/env-version` — `{currentVersion, fileVersion, mismatch,
  dismissed}`. `currentVersion` is `WEBMANAGER_ENV_TEMPLATE_PATH`'s
  `WEBMANAGER_ENV_VERSION` as read once at startup (`""` if the template was
  unreadable, in which case `mismatch` is always `false` — nothing to check
  against); `fileVersion` is `.env.webmanager`'s own value (`WEBMANAGER_
  ENV_VERSION` env var, possibly `""` for a pre-this-feature file). `dismissed`
  reflects `internal/envversionprefs` keyed to `currentVersion` — so a later
  image upgrade that bumps the template version automatically re-arms the
  banner even though a dismissal record for the old version still exists.
  Ungated (read-only, purely informational).
- `POST /api/system/env-version/dismiss` — persists that the user has seen
  the current mismatch warning (`internal/envversionprefs`). `400` if there's
  no `currentVersion` to key the dismissal to (template was unreadable at
  startup). Ungated, same tier as `PUT /api/ui/sidebar-order` — no security
  relevance, just a "don't nag me again" UI preference.

All error responses are `{"error": "message"}` with an appropriate 4xx/5xx
status.
