# webmanager

Scoped guidance for anyone (human or agent) working under `webmanager/`. Read
`plan.md` first — it's kept short (current status + a linked TODO table only).
Each feature's full design/history lives in `webmanager/.claude/` — only open
the one you're actually about to touch, not all of them. Files directly under
`webmanager/.claude/` (no subfolder) are actionable work items only; done
features, user-QA-pending features, joint-research-needed features,
feedback logs, and cross-cutting context docs each live in their own
subfolder (`archive/`, `qa-request/`, `research/`, `feedback/`, `base/`) —
`webmanager/.claude/README.md` is the index and explains the split.

## Priority order

**Already implemented** — Supervisor (responsive log dialog/bottom-sheet,
per-program capability metadata that can disable start/stop/restart/logs with
an explanatory note — `vector`'s log button is disabled this way, per-program
PID-tree expand reusing the Processes tab's tree utility), an SSH Keys tab
(`components/SshKeys/`) covering every SSH-level concern shared by any
ssh/scp connection, not just git (`authorized_keys` list, a default SSH
identity key — `SSH_DEFAULT_KEY_PATH`, `~/.ssh/id_ed25519` — with
generate-if-missing + public-key copy, per-host `~/.ssh/config` entries with
auto-generated ed25519 keys, `known_hosts` management, and raw
`~/.ssh/config` editing gated on reads too, not just writes, since it can
carry `ProxyJump`/usernames/internal hostnames — validated via `ssh -F <tmp>
-G <placeholder>` before saving, mirroring `.gitconfig`'s `git config -f
<tmp> -l` validation, see `internal/gitconfig/sshconfigraw.go`; these last
four used to live under the Git Config tab but moved here since none of them
are actually git-specific), a Git Config tab (name/email, SSH+GPG signing,
HTTPS credentials, git-lfs install, raw `.gitconfig` editing) — a Tailscale tab
also lives here (forwards/publish CRUD, status, login trigger), and a DNS tab
(blocklist sources, MagicDNS-style custom hosts, resolver override — see root
`CLAUDE.md`'s "DNS management"), Net 관리(netgate outbound/forwards), and
tinyauth (user CRUD) — six tabs total — the same way, but none of them are
webmanager's own feature: each always `<iframe>`-embeds router's own
`/router/` page (`components/RouterEmbed/RouterFrame.tsx`), pointed at the
same-origin `/router/` path by default or, when `ROUTER_MANAGER_HOSTS` is
configured, a cross-origin `<iframe>` into that dedicated domain instead (see
`docs/router.md`'s "보안: 공유 origin과 전용 도메인") — both cases are an
iframe, there is no same-origin direct-render fallback anymore. As of the
2026-08-08 decoupling (`router/CLAUDE.md`, `.claude/archive/router-frontend-decouple-plan-done.md`)
webmanager's frontend has zero `@code-docker/router-frontend` dependency at
all — the handful of generic UI primitives it still needs (`ErrorBanner`/
`Sheet`/`Skeleton`) are hand-duplicated locally instead of imported from that
package. webmanager's own `internal/tailscale` backend
package (config CRUD, status,
login) was fully deleted when tailscale moved to the `router/` container —
see `router/CLAUDE.md` and `docs/router.md#tailscale` for the current
design. Logs (real vector-backed data, time-range filter + cursor
pagination, sticky filters with an internally-scrolling table, live mode that
appends instead of replacing), a "작업 관리자" (Task Manager) tab — renamed
from "Processes" — split into 성능/프로세스 sub-tabs (host-wide per-core CPU
heatmap, host-physical memory breakdown alongside cgroup used/limit,
best-effort clock/temperature; process list+tree dual view, status filter,
fuzzy search with match highlighting, client-side DOM pagination), Claude Code
status tab M1+M2+M3, Docker/dind management M1+M2+M3 (container/image
list + log tail, `internal/dind` CLI shell-out; start/stop/remove with
mandatory confirm dialogs, password-gated; a password-gated `docker inspect`
detail view — the only gated read among list/logs/inspect, since
`Config.Env` can expose plaintext secrets), a per-top-level-
directory container disk breakdown in Task Manager (`internal/diskusage`,
`du`-based, cached + explicit-trigger-only like the Projects scan), code-server extension recommend/install (categorized,
collapsible, installed-list section, an open-vsx "더 보기" link, a
show/hide-recommendations toggle persisted in localStorage), Projects tab
phase 1, mise management (same collapsible/toggle treatment as extensions,
defaults inverted — mise categories start collapsed) plus a tool-search
dialog (`Mise/ToolSearchDialog.tsx` — `GET /api/mise/registry/search`, a
6h-TTL in-memory cache over `mise registry --json`'s ~1000 entries, explicit
search-button/Enter trigger rather than debounce-as-you-type, min 2-char
query; each result offers a quick one-click `latest` install or "버전 보기"
into a scrollable/filterable `mise ls-remote --json` version picker,
deliberately uncached since even a cold call is sub-second) and a shared
top-level `Mise/JobDialog.tsx` wrapper so every mise-tab job action
(recommend install, search install, delete, deactivate, reactivate)
presents through the same pinned-near-top modal instead of `JobPanel`
rendering inline — `.claude/archive/mise-search-plan-done.md`,
ClaudeCode.tsx's own `JobPanel` usage deliberately
untouched since it already has its own full-tab overlay, web terminal M1+M2
(ephemeral PTY session, on-screen mobile controls with sticky modifiers,
customizable keybindings, 10 built-in + custom color themes, named
persistent sessions with a real tab bar/pin-toggle backed by
`internal/termsession`, keyboard-aware mobile layout, edge-to-edge
theme-matched surface), a Claude Code install button (reuses the mise install
job plumbing — `POST /api/claude/install` resolves the latest version via
`mise latest claude-code` and installs through the same `mise.JobStore` the
mise tab uses, `Mise/JobPanel.tsx` extracted so both tabs share the same
progress/log UI + code-server-restart prompt), a mise-backed version check for
Claude Code specifically (current vs. `mise latest claude-code`, shown only
when the tool is present in the mise *global* tool list — i.e. actually
managed by mise — with an "지금 업데이트" button reusing the same install
endpoint, and a backend-persisted "버전 확인 끄기" checkbox,
`internal/claudecode/prefs.go`, since this should follow the user across
browsers/devices unlike the mise tab's `localStorage`-only toggles; the check
itself lives on its own `GET /api/claude/mise-version` endpoint, not bundled
into `/api/claude/status` — `mise latest` can be a real registry round-trip,
so folding it into the main status fetch made every tab open wait on it even
with the check turned off; the frontend renders a small version tag next to
the page title and only shows a banner when an update is actually available,
skipping the fetch entirely when the pref is on), and an
in-browser Claude Code login flow (`internal/claudecode/login.go`'s
`LoginManager` runs `claude auth login` as a managed background subprocess —
plain `os/exec` pipes are sufficient, empirically confirmed no PTY is needed
— extracts the sign-in URL from its output via regex, and relays a
user-pasted code back to its stdin; entirely password-gated like Terminal,
not read-open like most of this app, since it's a live auth flow rather than
a passive read). This reverses `claude-plan.md`'s earlier explicit decision
to leave login to the user's own terminal — that assumed SSH/code-server
access was always available, which stopped being true once webmanager needed
to support org/company deployments where webmanager itself is the only
surface ever opened. A Claude Code conversation-log viewer inside the same
tab (`.claude/archive/claude-session-log-plan-done.md`, `internal/claudecode/sessions.go`) lists
and renders every session transcript found under
`CLAUDE_CONFIG_DIR/projects/*/*.jsonl` as a condensed chat view — the
backend stays schema-agnostic (cheap listing + raw cursor-paginated line
reads only, same pattern as `internal/logstore`) while all parsing happens
frontend-side against a vendored copy of `d-kimuson/claude-code-viewer`'s
Zod schema module (`frontend/src/vendor/claude-conversation-schema/`, MIT,
not an installable package so it's a manual periodic re-sync rather than a
real dependency) — this deliberately reverses `claude-plan.md`'s original
"stats-cache.json only, raw transcripts too version-fragile" decision, but
only on the frontend side, so the backend's format-agnostic contract still
holds if the JSONL shape drifts. Gated entirely like Terminal/Files/Logs
(session content, not a passive read) despite living inside the otherwise
open Claude tab — `RequiresUnlock` wraps just that sub-section, not the
whole tab, which the component doc comment notes is a supported pattern
(not only from `App.tsx`). Sub-agent/sidechain transcripts and
externally-spilled tool-result files are out of scope for v1. A shared
password gate (`internal/authgate` — see `.claude/archive/authgate-plan-done.md` for
the full list of what it gates; principle is reads-stay-open/writes-gated,
with Terminal/File Manager/Logs/Sessions/Supervisor-log-view/Claude-session-log
gated entirely), a file
manager, a shared lazy-loaded CodeMirror 6 editor component, a responsive
layout with a mobile hamburger/drawer sidebar (now also independently
scrollable so short viewports can reach every item), a centralized
`index.css` color-token system (light + dark values for every base UI token
and the data-viz `--viz-cat-*`/`--viz-seq-*` palette, previously duplicated
per-component with no real dark mode for base UI at all) with a 3-way
manual theme toggle (system/light/dark cycled via one `lucide-react` icon
button pinned to the sidebar footer's right edge, `data-theme` attribute +
per-device `localStorage`, `src/theme.ts`/`src/useTheme.ts`) and a sidebar
footer lock-status indicator on the left (shows a live "N분 남음" countdown
from `GET /api/auth/status`'s `unlockedUntil`, click to pre-unlock via the
shared `UnlockModalHost` queue). `lucide-react` is also used for the
terminal's tab pin/close/add icons. Sidebar tab switches and the theme
toggle both animate via the View Transition API (`src/utils/
viewTransition.ts`'s `withViewTransition`, a thin `document.
startViewTransition` wrapper with a synchronous browsers-without-support
fallback), and every tab's first-load state now shows a shared generic
shimmer placeholder (`components/common/Skeleton.tsx`) that cross-fades
into the real content via the same utility instead of snapping — see
"First-load skeleton" under Ground rules below for the pattern to follow
when adding a new tab. A `.env.webmanager` migration tool
(`webmanager --env-migrate`, `internal/envmigrate` — see
`.claude/archive/env-migration-plan-done.md`): reconciles a user's file
against the image's current `example-env.webmanager`, archiving removed keys
into a `#~` section and preserving both the user's actively-set values and
their own plain-`#` comments; `#!important`/`#!` template-only markers let an
org force a value or flag a changed recommended default without clobbering
the user's choice (`WEBMANAGER_ENV_VERSION` is just the first real use of
`#!important`); the template itself is read from a path
(`WEBMANAGER_ENV_TEMPLATE_PATH`, not `go:embed`) so orgs running multiple
instances can bind-mount their own; plus a startup log warning and a web UI
banner (dismiss state persisted backend-side via `internal/envversionprefs`)
when the running file is stale. A single-origin merge of code-server (`/`)
and webmanager (`/manager`) via an in-container nginx supervisord program
(`config/nginx/nginx.default.conf`, `[program:nginx]` — see
`.claude/archive/expose-plan-done.md`): code-server's `bind-addr` and
webmanager's `WEBMANAGER_ADDR` both moved to internal-only ports,
`code-config.default.yaml` is now regenerated on every start (no more
once-only guard) same as every other override-pattern file, and the 4
frontend call-sites that hardcoded `/api/...` outside `src/api/client.ts` now
go through `apiUrl()`/`import.meta.env.BASE_URL`. Code/build-verified only —
real-container QA by the repo owner is still pending. A follow-on milestone
(opening `/manager` as a widget/iframe from inside the code-server PWA, or a
PWA `shortcuts` entry) had 4 open questions in `.claude/question.md`; trigger
and display-form are now implemented (`.window-appicon` click opens `/manager`
in an iframe overlay modal, `config/code/code-patch/webmanager-launcher.default.js`
— see `.claude/archive/expose-plan-done.md`'s "나중 마일스톤" section);
the PWA `shortcuts` entry is now implemented too
(`.claude/archive/manifest-shortcuts-plan-done.md`) — rather than a
second installable PWA (rejected: it would double the installed-app icon
count per code-docker instance for a "check occasionally" use case),
`config/nginx/nginx.default.conf` intercepts just `/manifest.json` with an
exact-match `location` that proxies to a new webmanager package
(`internal/manifestpatch`) which fetches code-server's real manifest
straight from its internal port, merges in a `shortcuts` array (an "Open
manager" jump-list entry pointing at `/manager/`) leaving every other field
exactly as fetched, and responds 502 on any failure so nginx's
`error_page 502 503 504 = @manifest_fallback` — the same idiom
`/_code_not_ready.html` already uses — falls back to code-server's own
manifest directly; code-server-autoinstall's vendored manifest route itself
is never touched. An "열린 세션" (open sessions)
tab (`.claude/archive/session-heartbeat-plan-done.md`, `internal/
sessionheartbeat`) lists which code-server browser tabs are currently
connected and what folder each has open, fed by a client-generated UUID that
a new code-patch script (`config/code/code-patch/session-heartbeat.default.js`)
POSTs to `/api/sessions/heartbeat` every 30s — chosen over querying
code-server's own connection API specifically to sidestep that approach's
unresolved feasibility question (`.claude/archive/session-viewer-plan.md`,
kept only as a record of the unresearched option); `GET /api/sessions` is
password-gated and the whole tab is wrapped in `RequiresUnlock` in `App.tsx`
like Terminal/Files/Logs, but the heartbeat POST itself is deliberately left
ungated, a documented exception to the
reads-open/writes-gated convention since code-server runs with `auth: none`
and has no credential to attach to that request in the first place. A Dev
Proxy tab (`.claude/qa-request/caddy-plan-done.md` — historical only, see
below) `<iframe>`-embeds router's `/router/` page (`RouterFrame`, see the
Tailscale tab entry above) for expose CRUD (structured route editor + raw
`.caddy` fragment fallback) against router-manager's `/api/dev-proxy/*`. App
Routes works the same way. webmanager's own `internal/
devproxy` package, the `caddy-adapter` supervisord program, and
`internal/authgate`'s `forward_auth`/`/manager/dev-auth` wiring described in
that archive doc were all deleted — Caddy now lives on the `router`
container and per-expose auth goes through tinyauth instead (see
`router/CLAUDE.md` and `docs/dev-proxy.md`). `internal/authgate` here is
back to gating only webmanager's own write-gate (10 min TTL), with no
second forward-auth TTL to carry. A
per-project git status panel (`.claude/qa-request/project-git-status-plan-done.md`,
`internal/projectgit`) reports status/log/diff/remotes/branches/tags for one
already-known project path — read-only only (no stage/commit/push/pull yet),
ungated since it's read-only, and deliberately placed in
`components/common/Git/` so it isn't tied to the Projects tab specifically.
The Projects tab's per-project detail sheet (opened from `ProjectTable.tsx`)
now also carries a git worktree list/remove panel
(`components/common/Git/WorktreesPanel.tsx`, `internal/projectgit/
worktree.go` — listing is ungated like the status panel above, but `git
worktree remove` is a real mutation so it's password-gated + confirm-dialog
gated, same convention as delete-reclaimable), a project-scoped Claude Code
session history section (`components/Projects/ProjectSessionHistory.tsx`)
that reuses the Claude tab's own `ClaudeCode/SessionLog/SessionLog.tsx`
wholesale via a `projectFilter` prop threading into `GET /api/claude/
sessions?project=<path>` (`internal/claudecode.FilterSessionsByProject`) —
gated exactly like the main session-log sub-tab, since it's the same
conversation content, not a new trust tier — and a Claude Code auto-memory
viewer (`components/Projects/ProjectMemoryPanel.tsx`, `internal/
claudememory`, reading `CLAUDE_CONFIG_DIR/projects/<slug>/memory/`) that's
deliberately ungated (curated summary notes, not raw transcripts) and
collapsed-by-default/lazy-fetched since most projects have never had Claude
Code run against them. Git Config also gained a global-gitignore editor
(`components/GitConfig/GlobalGitignore.tsx`, `internal/gitconfig/
excludesfile.go` — whatever `core.excludesFile` points at, read ungated/
write gated, same raw-editor shape as `.gitconfig`'s own raw editing). Keep extending as
needed; see `plan.md`'s "구현 완료" table before assuming something isn't
done yet. **Open questions the repo owner still needs to weigh in on are
consolidated in `.claude/question.md`** — none of them block further work,
they're just recorded defaults or genuinely-undecided design questions.

**Can be started anytime, independent of the queue below** (no blocking
dependencies on each other or on anything still queued):

1. `.claude/claude-rework-v2.md` — Claude Code status/management tab, **M4
   onward** (M1/M2/M3 done; install/mise-version-check/login automation are
   done too, as a separate track outside the M-numbering — see "Already
   implemented" above; the full M1-M3 design/implementation history moved to
   `.claude/archive/claude-plan-done.md`). M4 (extension-install banner, reuse the
   now-implemented extensions API) → M5 (MCP server list, deliberately last
   within this feature — `claude mcp list` has no `--json` output and needs a
   real multi-server example to design the parser against).
2. `.claude/extension-search-plan.md` — extension search + marketplace-URL
   paste-to-install (with an open-vsx cross-lookup + vsix-direct-download
   fallback). Design done, not started.

Projects tab phase 2 (`.claude/archive/projects-plan-done.md`, delete UI for
reclaimable folders) is now done too — same exact-match path-validation
convention as phase 1's rescan endpoint, extended to a project+reclaimable-path
pair (`internal/projects.Scanner.DeleteReclaimable`), plus a mandatory confirm
dialog. The "code-server에서 열기" link also now falls back to
`window.location.origin` when `WEBMANAGER_CODE_SERVER_URL` is unset (same-origin
nginx routing made that a safe default) and renders as a real `<a href>` instead
of a `window.open` button.

**Lower-priority / no dedicated plan doc yet** — tracked only in `plan.md`'s
TODO table: code-server settings.json editor (the CodeMirror editor built for
git raw-config editing/the file manager already covers the "no editor
component" blocker, but the conclusion is still to skip this — code-server's
own integrated editor is already a better experience than webmanager
reimplementing settings-schema validation/autocomplete, see `ideas.md`),
bind-address strategy (last priority), vector JSONL log retention policy,
i18n (LinguiJS, deliberately deferred until strings stabilize), embedding a
code-docker help/guide inside webmanager (`.claude/research/guide-plan.md` —
idea stage only, explicitly not to be implemented until the repo owner
answers the open questions in that doc), a code-server/mise version-check
panel (`.claude/research/version-panel-plan.md` — same idea-stage tier as
guide-plan, explicitly lowest priority, several genuinely unresolved
questions like what signal even means "container rebuild needed"), a file
manager rework (`.claude/research/filemanager-rework-plan.md` — drag-drop
move, grid/list/table views, multi-tab, benchmarked loosely against Termix;
lowest-priority tier, scope needs to be discussed with the repo owner
before starting — several open questions in the doc, e.g. whether grid-view
thumbnails conflict with the existing file manager's deliberate no-thumbnails
decision).

## Ground rules

- Before running `docker compose build`/`up`/`restart` against the live
  container, confirm it's actually safe — someone else may be iterating on
  it. If you don't know, ask rather than assume; local `go build`/`go vet`
  (backend) and `npm run build`/lint (frontend) are always safe fallback
  verification.
- Follow the root `CLAUDE.md`'s override pattern and code style (minimal
  comments, no premature abstraction) for anything touching outside
  `webmanager/` (Dockerfile, docker-compose.yml, supervisord.conf, etc).
- Security patterns to repeat (from `.claude/archive/webmanager-review.md` (레포 루트), a full bug-fix
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
  backend-persisted JSON file under `/code/.local/share/code-docker/webmanager/` instead (see
  `internal/terminalsettings` for the pattern: whole-document GET/PUT,
  atomic write via temp-file+rename).
- **First-load skeleton**: any tab/panel's "no data yet" state should render
  `components/common/Skeleton.tsx`'s `<Skeleton />` instead of a bare
  `<p className="empty-state">불러오는 중...</p>`. It's deliberately generic
  (a handful of shimmering bars, not shaped to that component's real
  layout — tabs vary too much for a per-component skeleton to be worth
  maintaining, and matching the final layout isn't necessary for it to read
  as "loading"). Pair it with `utils/viewTransition.ts`'s
  `withViewTransition` around the loading-flag setter's `finally`-block call
  (`withViewTransition(() => setLoading(false))` instead of a bare
  `setLoading(false)`) so the swap to real content cross-fades instead of
  snapping instantly — same utility the sidebar tab switch and theme toggle
  already use for the same reason. Only convert a component's own top-level
  "nothing loaded yet" placeholder this way; leave button-label loading text
  (`{loading ? '불러오는 중...' : '새로고침'}`) and small nested per-item
  loading states (e.g. Supervisor's per-program process-tree expand) as
  plain text — those aren't full-section states and a big skeleton block
  would look oversized there.
- **Process tree**: `src/utils/processTree.ts`'s `buildProcessTree(processes,
  rootPid?)` is a reusable, backend-free utility (built from the existing
  `ppid` field already returned by `GET /api/processes`) — reuse it rather
  than re-deriving a tree anywhere a PID hierarchy is useful (already used by
  both the 작업관리자 탭 and Supervisor's per-program expand).
- **`example-env.webmanager`**: whenever a change adds/removes/renames a key
  or meaningfully changes a default, bump `WEBMANAGER_ENV_VERSION` in that
  file itself (it's the single source of truth — no separate Go constant to
  keep in sync, see `.claude/archive/env-migration-plan-done.md`). Keep every descriptive/
  section-header comment prefixed `#.` (never a bare `#`, including blank
  spacer lines within a multi-line explanation) — bare `#` is reserved for
  content a *user* adds to their own `.env.webmanager`, and `--env-migrate`
  relies on that distinction to know what to preserve across a migration.
