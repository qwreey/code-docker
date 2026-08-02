# webmanager

Scoped guidance for anyone (human or agent) working under `webmanager/`. Read
`plan.md` first — it's kept short (current status + a linked TODO table only).
Each feature's full design/history lives in `webmanager/.claude/` (done
features: `*-plan-done.md`; not-yet-done: `*-plan.md`, no suffix) — only open
the one you're actually about to touch, not all of them. `webmanager/.claude/
README.md` is the index.

## Priority order

**Already implemented** — Supervisor, SSH keys, git config (name/email,
SSH+GPG signing, SSH hosts, HTTPS credentials), Tailscale forwards/publish,
Logs (real vector-backed data), Processes/Ports, container-wide cpu/mem/disk
resource tracking. Keep extending as needed; see `plan.md`'s "구현 완료" table
before assuming something isn't done yet.

**Can be started anytime, independent of the queue below** (no blocking
dependencies on each other or on anything still queued):

1. `.claude/claude-plan.md` — Claude Code status/management tab. **M1 (login
   status + basic usage-stats overview, no graphs) is ready to implement
   now.** Its own doc stages M2 (heatmap/graphs, follow the `dataviz` skill)
   → M3 (skills/plugins list) → M4 (extension-install banner) → M5 (MCP
   server list, deliberately last within this feature — `claude mcp list` has
   no `--json` output and needs a real multi-server example to design the
   parser against). Login/OAuth automation is explicitly NOT a milestone —
   the user does that manually; don't build it unless asked.
2. `.claude/extensions-plan.md` — code-server extension recommend/install.
   Priority: medium. No mise dependency, no editor component needed, no open
   technical decisions — just a CLI shell-out
   (`code-server --install-extension`) + a small list UI.

**Queued, in this order** (next big subsystem after whichever is in flight):

3. `.claude/dind-plan.md` — Docker/dind management. Not started.
4. `.claude/terminal-plan.md` — web terminal (PTY). Not started. Similar
   difficulty tier to dind; the user ordered dind first.
5. `.claude/caddy-plan.md` — Caddy-based dev-server expose (wildcard
   subdomain reverse proxy). Design fully done, not started. User explicitly
   placed this after dind/terminal ("이건 에디팅 도구 만들기라 그 아래") and
   before mise.
6. **mise — deliberately last priority.** The tool/version surface is too
   broad to design well under time pressure. `.claude/mise-plan.md` has a
   pre-designed "recommendations" sub-feature (categorized tool list +
   `recommendations.default.yaml`) meant to land alongside mise itself.

**Lower-priority / no dedicated plan doc yet** — tracked only in `plan.md`'s
TODO table: code-server settings.json editor (revisit once caddy-plan's
Monaco decision lands, see `ideas.md`), tailscale login status surfaced in
webmanager too, bind-address strategy (last priority), vector JSONL log
retention policy.

## Ground rules

- Before running `docker compose build`/`up`/`restart` against the live
  container, confirm it's actually safe — someone else may be iterating on
  it. If you don't know, ask rather than assume; local `go build`/`go vet`
  (backend) and `npm run build`/lint (frontend) are always safe fallback
  verification.
- Follow the root `CLAUDE.md`'s override pattern and code style (minimal
  comments, no premature abstraction) for anything touching outside
  `webmanager/` (Dockerfile, docker-compose.yml, supervisord.conf, etc).
- Security patterns to repeat (from `webmanager/review.md`, a full bug-fix
  pass across the whole codebase): validate any user input that flows into a
  file path (`filepath.Join`) or another config file's own syntax (SSH
  config, YAML) before use — reject unsafe charsets rather than escaping;
  validate fixed-format identifiers (fingerprints, IDs) with a strict regex
  before passing to `exec.Command` (a value starting with `-` can be
  misparsed as a flag); make partial-failure log/file reads degrade
  gracefully per-line/per-file rather than failing the whole request; every
  destructive frontend action (delete/kill/start-stop-restart) needs a
  confirm dialog, no exceptions — this was a critical bug once already
  (Supervisor tab had none).
