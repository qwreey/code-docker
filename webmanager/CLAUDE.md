# webmanager

Scoped guidance for anyone (human or agent) working under `webmanager/`. Read
`plan.md` first — it's kept short (current status + a linked TODO table only).
Each feature's full design/history lives in `webmanager/.claude/` (done
features: `*-plan-done.md`; not-yet-done: `*-plan.md`, no suffix) — only open
the one you're actually about to touch, not all of them. `webmanager/.claude/
README.md` is the index.

## Priority order

**Already implemented** — Supervisor (responsive log dialog/bottom-sheet,
per-program capability metadata that can disable start/stop/restart/logs with
an explanatory note — `vector`'s log button is disabled this way, per-program
PID-tree expand reusing the Processes tab's tree utility), SSH keys, git
config (name/email, SSH+GPG signing, SSH hosts, HTTPS credentials, git-lfs
install, raw `.gitconfig` editing, known_hosts management), Tailscale
forwards/publish, Logs (real vector-backed data, time-range filter + cursor
pagination, sticky filters with an internally-scrolling table, live mode that
appends instead of replacing), a "작업 관리자" (Task Manager) tab — renamed
from "Processes" — split into 성능/프로세스 sub-tabs (host-wide per-core CPU
heatmap, host-physical memory breakdown alongside cgroup used/limit,
best-effort clock/temperature; process list+tree dual view, status filter,
fuzzy search with match highlighting, client-side DOM pagination), Claude Code
status tab M1+M2+M3, code-server extension recommend/install (categorized,
collapsible, installed-list section, an open-vsx "더 보기" link, a
show/hide-recommendations toggle persisted in localStorage), Projects tab
phase 1, mise management (same collapsible/toggle treatment as extensions,
defaults inverted — mise categories start collapsed), web terminal M1
(ephemeral PTY session, on-screen mobile controls with sticky modifiers,
customizable keybindings, 10 built-in + custom color themes), a shared
password gate (`internal/authgate` — see `.claude/authgate-plan-done.md` for
the full list of what it gates; principle is reads-stay-open/writes-gated,
with Terminal/File Manager/Logs/Supervisor-log-view gated entirely), a file
manager, a shared lazy-loaded CodeMirror 6 editor component, a responsive
layout with a mobile hamburger/drawer sidebar (now also independently
scrollable so short viewports can reach every item). Keep extending as
needed; see `plan.md`'s "구현 완료" table before assuming something isn't
done yet. **Open questions the repo owner still needs to weigh in on are
consolidated in `.claude/question.md`** — none of them block further work,
they're just recorded defaults or genuinely-undecided design questions.

**Can be started anytime, independent of the queue below** (no blocking
dependencies on each other or on anything still queued):

1. `.claude/claude-plan.md` — Claude Code status/management tab, **M4
   onward** (M1/M2/M3 done). M4 (extension-install banner, reuse the
   now-implemented extensions API) → M5 (MCP server list, deliberately last
   within this feature — `claude mcp list` has no `--json` output and needs a
   real multi-server example to design the parser against). Login/OAuth
   automation is explicitly NOT a milestone — the user does that manually;
   don't build it unless asked.
2. `.claude/projects-plan-done.md` — Projects tab phase 2 (delete UI for
   reclaimable folders). Phase 1 (read-only) is done; phase 2 needs the exact
   same path-validation pattern already used by phase 1's rescan endpoint
   (exact match against the cache) plus a confirm dialog, no exceptions.
3. `.claude/terminal-plan.md` — web terminal **M2** (named persistent
   sessions surviving tab close). Everything else about the terminal
   (ephemeral M1, the password gate, mobile controls/keybindings/themes) is
   done — M2 is purely about session lifecycle now. Design notes already
   laid (avoid tmux/screen per the repo owner's explicit request — manage the
   PTY's lifecycle directly instead).
4. `.claude/extension-search-plan.md` — extension search + marketplace-URL
   paste-to-install (with an open-vsx cross-lookup + vsix-direct-download
   fallback). Design done, not started.
5. `.claude/theme-toggle-plan.md` — manual light/dark toggle in a sidebar
   footer bar (alongside an unlock-status indicator for the password gate).
   Design done, not started — check the doc's note about confirming how dark
   mode is currently expressed across existing component CSS before
   estimating effort.

**Queued, in this order** (next big subsystem after whichever is in flight):

6. `.claude/dind-plan.md` — Docker/dind management. Not started, but
   **research is done**: CLI shell-out (not the official Go SDK, consistent
   with every other webmanager feature), `docker run`/`exec`/`cp` explicitly
   out of scope, log streaming via the existing polling convention (not the
   terminal's WebSocket infra). One open scope question in `question.md`.

**Lower-priority / no dedicated plan doc yet** — tracked only in `plan.md`'s
TODO table: code-server settings.json editor (revisit once caddy-plan's
Monaco decision lands, see `ideas.md` — though the CodeMirror editor built
this round already lowers that decision's stakes), tailscale login status
surfaced in webmanager too, bind-address strategy (last priority), vector
JSONL log retention policy, i18n (LinguiJS, deliberately deferred until
strings stabilize), embedding a code-docker help/guide inside webmanager
(`.claude/guide-plan.md` — idea stage only, explicitly not to be implemented
until the repo owner answers the open questions in that doc), a code-server/
mise version-check panel (`.claude/version-panel-plan.md` — same idea-stage
tier as guide-plan, explicitly lowest priority, several genuinely unresolved
questions like what signal even means "container rebuild needed"). `.claude/
caddy-plan.md` — Caddy-based dev-server expose (wildcard subdomain reverse
proxy) — also lives here, deliberately below dind/terminal-M2: most of its
design is settled, but it still has open decisions (e.g. `preserve_host`
default) and was explicitly deprioritized below the rest of the active
queue.

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
- **Password gate**: `internal/authgate`'s `Gate.RequirePassword` wraps
  individual route registrations in `main.go` (see any of the many examples
  there) — reads stay open, writes get wrapped, per feature this is already
  applied to. It's a shared `*Gate` instance (`s.gate`), reuse it rather than
  building a second gate for a new feature. Frontend features don't need any
  special handling for this — `src/api/client.ts`'s `request()` has a global
  401→unlock-modal→retry interceptor, so a plain `api.post`/`put`/`del` call
  just works once gated; only whole-tab-gated features (Terminal/Files/Logs)
  need the explicit `<RequiresUnlock>` wrapper in `App.tsx`.
- **Client-side-only UI preferences** (collapse state, show/hide toggles) use
  `localStorage` directly (see `Extensions.tsx`/`Mise.tsx` for the
  established `try/catch`-wrapped load/save helper pattern) — no backend
  persistence for these, they're per-browser by design. Contrast with
  settings that should follow the user across devices or that another
  feature reads (e.g. terminal keybindings/themes), which go through a
  backend-persisted JSON file under `/code/.webmanager/` instead (see
  `internal/terminalsettings` for the pattern: whole-document GET/PUT,
  atomic write via temp-file+rename).
- **Process tree**: `src/utils/processTree.ts`'s `buildProcessTree(processes,
  rootPid?)` is a reusable, backend-free utility (built from the existing
  `ppid` field already returned by `GET /api/processes`) — reuse it rather
  than re-deriving a tree anywhere a PID hierarchy is useful (already used by
  both the 작업관리자 tab and Supervisor's per-program expand).
