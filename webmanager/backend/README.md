# webmanager backend

Go backend for the webmanager admin panel. Implements supervisord process
management (over the existing `/run/supervisor.sock` XML-RPC socket), SSH
`authorized_keys` management, and git configuration (user.name/email, SSH
host keys, HTTPS credential store). See `../plan.md` for the wider design
context — tailscale, mise, dind, and the web terminal are deliberately not
implemented here yet.

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
| `WEBMANAGER_STATIC_DIR` | `./static` | pre-built frontend assets (see below) |

## Frontend integration

`WEBMANAGER_STATIC_DIR` is where the separately-built frontend's `dist/`
output gets pointed once the frontend exists — this directory doesn't need
to exist for the backend to run (any request falls through to a plain 404).
Any non-`/api` GET request is served from that directory, falling back to
`index.html` for SPA client-side routing when the requested path isn't a
real file.

## API contract

Implemented exactly per `../plan.md`'s MVP scope:

- `GET /api/supervisor/processes`
- `POST /api/supervisor/processes/{name}/start|stop|restart`
- `GET /api/supervisor/processes/{name}/log?stream=stdout|stderr&tail=N`
- `GET/POST /api/ssh/keys`, `DELETE /api/ssh/keys/{id}`
- `GET/PUT /api/git/config`
- `GET/POST /api/git/ssh-hosts`, `DELETE /api/git/ssh-hosts/{host}`
- `GET/POST /api/git/credentials`, `DELETE /api/git/credentials/{host}`

All error responses are `{"error": "message"}` with an appropriate 4xx/5xx
status.
