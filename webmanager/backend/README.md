# webmanager backend

Go backend for the webmanager admin panel. Implements supervisord process
management (over the existing `/run/supervisor.sock` XML-RPC socket), SSH
`authorized_keys` management, git configuration (user.name/email, SSH host
keys, HTTPS credential store, commit signing + GPG key management),
tailscale forwards/publish config CRUD, a cross-service logs API backed by
the `vector` JSONL pipeline, an OS-level process/port viewer
(`github.com/shirou/gopsutil/v4`) for finding and killing stray processes
squatting on a port, a whole-container cpu/mem/disk resource endpoint
read directly from this container's own cgroup v2 pseudo-files (see
`internal/cgroup`), and a read-only Claude Code status overview (login
state + local usage stats, see `internal/claudecode`). See `../plan.md` for
the wider design context — tailscale login/status, mise, dind, and the web
terminal are deliberately not implemented here yet.

## Build

```sh
go build -o webmanager .
```

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
TAILSCALE_CONFIG_PATH=/tmp/wm-dev/tailscale-config.yaml \
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
| `TAILSCALE_CONFIG_PATH` | `/code/.tailscale/config.yaml` | tailscale forwards/publish config, read by `config/tailscale-forward.default.sh` |
| `SSH_SIGNING_KEY_PATH` | `/code/.ssh/signing_key` | dedicated ed25519 keypair generated for git SSH commit signing |
| `VECTOR_LOG_DIR` | `/code/.vector/logs` | directory of day-partitioned `<YYYY-MM-DD>.jsonl` log files written by the `vector` pipeline (see `.claude/archive/vector-logs-plan-done.md`) |
| `SYSTEM_DISK_PATH` | `/code` | path `GET /api/system/resources` runs `statfs` on to report disk usage — `/code` is the bind-mounted volume (`./code:/code`), so this reflects real host disk usage for that mount |
| `SYSTEM_DISK_BREAKDOWN_ROOT` | `/` | root path `GET /api/system/disk-breakdown` breaks down by top-level directory (see `internal/diskusage`) — deliberately `/` (the container's own root filesystem), not `SYSTEM_DISK_PATH` |
| `WEBMANAGER_DISK_BREAKDOWN_CACHE_PATH` | `/code/.webmanager/disk-breakdown-cache.json` | cache file for the disk breakdown scan (only recomputed on `POST .../scan`, same convention as `WEBMANAGER_PROJECTS_CACHE_PATH`) |
| `WEBMANAGER_STATIC_DIR` | `./static` | pre-built frontend assets (see below) |
| `WEBMANAGER_CLAUDE_BINPATH` | *(none)* | absolute path to the `claude` (Claude Code CLI) binary; if unset, falls back to a `claude` lookup on `PATH`. Neither found means "not installed" — a normal state, not an error |
| `CLAUDE_CONFIG_DIR` | `/code/.claude` | Claude Code's own standard env var for relocating `~/.claude`; webmanager reads `stats-cache.json` from directly under this directory and does not invent a separate `WEBMANAGER_`-prefixed equivalent |

GPG-backed endpoints (`/api/git/gpg-keys*`) additionally depend on the `gpg`
binary being on `PATH` (installed via `gnupg` in `config/build.default.sh`);
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
round (tailscale config CRUD, git commit signing/GPG, logs API):

Every request body is capped at 1 MiB (`http.MaxBytesReader`, applied
uniformly via a small middleware in `main.go`) — exceeding it fails the
`json.Decode` call, which every handler already maps to a plain `400`.

"Already exists" conflicts (SSH host, SSH key, tailscale forward/publish)
are `409 Conflict`, consistent with the supervisor package's
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
- `GET/PUT /api/tailscale/config` — `socksAddress`/`retryInterval` globals
- `GET/POST /api/tailscale/forwards`, `DELETE /api/tailscale/forwards/{name}`
  — `409` if `name` already exists
- `GET/POST /api/tailscale/publish`, `DELETE /api/tailscale/publish/{name}`
  (`mode` is `tcp` or `tls-terminated-tcp`, defaults to `tcp`) — `409` if
  `name` already exists
- Every tailscale mutation restarts the `tailscale-forward` supervisord
  program after a successful write (same effect as `bin/forward-reload`) —
  tailscale login/`tailscale up`/status are explicitly out of scope here
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

All error responses are `{"error": "message"}` with an appropriate 4xx/5xx
status.
