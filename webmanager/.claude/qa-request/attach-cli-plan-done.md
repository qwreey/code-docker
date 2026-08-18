# `webmanager --attach` — reach a webmanager terminal session from outside

**Status: implemented, code/build/backend-integration verified by the
agent; interactive human QA by the repo owner is what's left.** See the
checklist right below before touching code again.

## 핸드오버 체크리스트 (2026-08-18)

Everything here was exercised with synthetic test scripts (raw WebSocket
clients, `pty.fork()`-driven input) against a real rebuilt container, not by
a human typing at a real keyboard. Check these for real before considering
this done:

1. **Basic attach** — `attach <name>` from an actual SSH login, and from
   code-server's integrated terminal, both reaching a session already open
   in webmanager's own Terminal tab (not a fresh one).
2. **Concurrent live view** — open the same session in a webmanager browser
   tab *and* via SSH `attach` at once; type in one, confirm it shows up in
   the other immediately.
3. **Detach, default (Ctrl+])** — from a real terminal, press Ctrl+]. Confirm
   it prints `[detached]`, drops you back to your normal shell, and the
   session is still alive/unchanged if you `attach` again right after.
4. **Detach, configured** — in the Terminal tab's settings panel ("Attach
   종료 시퀀스" section), switch to the Ctrl+P Ctrl+Q preset, save, and
   confirm *that* now detaches instead (and that it's usable at all from a
   plain SSH shell — inside code-server's own terminal Ctrl+P is claimed by
   Quick Open, so it may not reach the PTY there at all; that's expected,
   not a bug to chase).
5. **Nested-attach refusal** — from inside an already-attached session, run
   `attach <anything>` (same name or a different one). Both must refuse
   immediately with the "already inside session ..." message — confirmed
   via synthetic env-var injection, not a real nested keystroke sequence.
6. **Password gate** — if `internal/authgate`'s password is ever turned on
   in a real deployment, confirm `attach` actually prompts for it and
   connects after a correct password (`attachAuthenticate` in
   `attachcmd.go`) — never exercised live, no password was configured in
   the dev environment this was built against.
7. **Settings panel sanity** — the "Attach 종료 시퀀스" section's save
   button was visually huge from a CSS bug (grid layout meant for 3 columns
   applied to a 2-element row) - fixed, but worth a glance to confirm it
   actually looks like a normal button now.

## What this is

The repo owner wanted SSH and code-server's integrated terminal to be able
to reach an **already-running webmanager Terminal-tab session** — not a
separate/parallel session, the literal same shell, so they can start
something on the phone via webmanager and pick it back up at a desk in
code-server's terminal without losing scrollback or juggling three
independent shells.

`webmanager --attach <name> [start-dir]` (`webmanager/backend/attachcmd.go`,
wrapped by `bin/attach` on `PATH` everywhere in the container) is a plain
WebSocket client for the **exact same** `GET /api/terminal?session=<name>`
endpoint a browser tab already uses (`handlers_terminal.go`'s
`handleNamedTerminal`/`relayTerminalSession`). Run it from SSH,
code-server's integrated terminal, or typed inside an ordinary webmanager
terminal tab (nesting into the *same* shell you're already running it from
is refused — see below):

```sh
attach main          # join (or, if it doesn't exist yet, create - same as
                      # clicking "+" in the Terminal tab) the session named "main"
attach main /code/foo # only honored on first creation, same as the
                       # Terminal tab's own cwd option
```

There is no separate session mechanism, no tmux, nothing webmanager's own
`internal/termsession.Registry` doesn't already track — an `attach`ed
session shows up in `GET /api/terminal/sessions` exactly like a browser tab
would, because as far as the backend is concerned, it *is* one.

## Design

**`internal/termsession.Session` now supports genuinely concurrent
multi-client attach**, not "last connection wins" — this is what makes a
browser tab and one or more `--attach` clients able to watch/type into the
same session at once. `Session.sinks` is a `map[uint64]writerFunc` instead
of a single `sink` field; `Attach()` adds a sink and returns a `detach` func
that removes only that one; `pump()` broadcasts every PTY chunk to all
currently-attached sinks, and a sink that errors (stalled/dead client) only
removes itself, never the others. `reapCheck`/`Info.Attached` now check
`len(sinks) > 0` instead of a nil check. This is the one real change to
ordinary webmanager Terminal-tab behavior — before, two browser tabs
couldn't even watch the same named session simultaneously (only sequential
reattach); now they can, same as a `--attach` client watching alongside one.

**Scrollback replay is now prefixed with a clear-screen sequence**
(`\x1b[2J\x1b[H`, `relayTerminalSession` in `handlers_terminal.go`) before
the ring buffer's raw bytes. The buffer is raw PTY output, not parsed
terminal state, so relative cursor-movement escapes in it only render
correctly starting from a known-blank screen. The browser frontend already
gets this for free (`Terminal.tsx` calls `term.reset()` before reconnecting)
but `--attach` hands the replay straight to a real terminal with whatever
was already on it, so the clear needed to move server-side to cover both
callers identically.

**`attachcmd.go`** (`webmanager --attach`):
- `GET /api/auth/status` then, if `internal/authgate` has a password
  configured, prompts for it (echo disabled via `golang.org/x/term`) and
  exchanges it for the unlock cookie via `POST /api/auth/unlock` — same
  flow the frontend's unlock modal uses, just from a terminal prompt. Skips
  entirely when no password is configured.
- Dials the WS endpoint with `github.com/coder/websocket`, puts the local
  tty in raw mode (`term.MakeRaw`), sends an initial resize control message
  and one more on every `SIGWINCH`, and relays stdin↔binary WS frames↔stdout
  until either side closes.
- **A configurable byte sequence detaches locally** without touching the
  remote session — it's just this process dropping its one sink, the same
  as closing a browser tab. Default is **Ctrl+]** (telnet's own traditional
  escape character — a single byte nothing else claims). Configurable per
  `internal/terminalsettings.Settings.DetachSequence`, edited in the
  Terminal tab's settings panel ("Attach 종료 시퀀스" section, reusing the
  existing `bytesToDisplay`/`displayToBytes` escape-notation input the
  keybinding editor already had) — two one-click presets (Ctrl+], Ctrl+P
  Ctrl+Q) plus a free-text field for anything else. `detachMatcher`
  (`attachcmd_test.go` has 6 unit tests) matches the configured sequence
  even when it spans more than one `os.Stdin.Read()` call, and correctly
  restarts matching on the exact byte that breaks a partial match (e.g.
  sequence "AB" against input "AAB" still detects the trailing "AB").
  - **Ctrl+P Ctrl+Q (Docker's own convention) was the original default and
    is still a one-click preset, but isn't the default anymore**: it
    collides with code-server's own Ctrl+P (Quick Open) — inside that
    integrated terminal Ctrl+P never reaches the PTY at all, so the
    sequence could never complete there.
  - **Ctrl+[ is deliberately never offered as a preset**, and the settings
    panel's description warns against typing it manually: it's the exact
    same byte (0x1B) as plain Escape, so it would fire on every Esc
    keypress in vim/readline/anything else, not just an intentional detach.
- **Nested attach is refused outright.** Every registry-backed session's
  shell gets `WEBMANAGER_TERMINAL_SESSION=<name>` in its environment
  (`internal/termsession/termsession.go`'s `newSession`); `attachCmd`
  checks this at startup and refuses to attach to *anything* — same name or
  a different one — the moment it's set, before even trying to connect.
  Originally this only blocked attaching back into the exact same session
  (an obvious direct mirror loop, confirmed live to cause violent screen
  flicker: two sinks both broadcasting into the same PTY that's also being
  rendered by the outer client), but attaching to a *different* session
  from inside one isn't safe either once nesting can chain (A into B,
  something inside B attaching back into A is the same class of loop one
  level removed) — so nesting is blocked entirely rather than only
  detecting the direct case. Detach (or close the browser tab) before
  attaching to anything else.

**`bin/attach`** is a two-line wrapper: `exec /etc/code-docker/webmanager/
webmanager --attach "$@"`. No Dockerfile change beyond what already ships
`bin/` and the `webmanager` binary.

## History — two earlier attempts, both reverted the same day (2026-08-18)

1. **All-tmux.** First version routed *every* registry-backed `Session`
   through `tmux new-session -A` unconditionally — every webmanager Terminal
   tab became a tmux client, and `bin/attach <name>` (`tmux attach-session`)
   let SSH/code-server join. Live testing found three real problems in
   order: (a) `attach <name>` could create tmux sessions webmanager's own
   registry never knew about; (b) forcing tmux onto every session broke the
   frontend's own default tab naming against a newly tmux-safe charset;
   (c) **the actual dealbreaker**: wrapping every session in tmux broke
   full-screen/alt-screen apps and glyph rendering for completely ordinary
   use (`claude`'s own TUI included) — "전혀 내가 원한 바는 아니였음."
2. **Standalone tmux tool.** Kept `bin/attach` as a fully independent tool
   (`tmux new-session -A`, no coupling to webmanager's own registry at all)
   — fixed the glyph/full-screen regression, but wasn't actually what was
   wanted either: "외부에서 attach 가 가능하면 좋겠음... 이미 존재하는
   webmanager 쉘에 접근하고 싶다는거였음" — the ask was always to reach an
   *already-running webmanager session*, not a separate parallel one that
   just happened to also be reachable from SSH.

Both reverts left `internal/termsession`'s core session lifecycle
(`newSession`, bare shell, no tmux) untouched — this final design keeps
that and only changes `Attach`'s single-sink→multi-sink model plus the
clear-prefix on replay, exactly the two things actually needed for external
attach to work correctly. `tmux` was removed from
`config/build/build.default.sh`'s pacman list again — nothing in the image
uses it.

## Bugs found by the repo owner's own live testing, after the design above shipped

All fixed same day, in order:

1. **Detach didn't work in a single (non-nested) attach.** Root cause:
   the *original* default (Ctrl+P Ctrl+Q) collided with code-server's own
   Ctrl+P shortcut — self-diagnosed by the repo owner before I even looked.
   Fixed by changing the default to Ctrl+] and keeping Ctrl+P Ctrl+Q as an
   opt-in preset.
2. **Settings panel's save button rendered huge.** Root cause: the new
   "Attach 종료 시퀀스" row reused `.terminal-keybinding-row`'s CSS (a
   3-column grid sized for `[label, bytes, delete]`) for a 2-element row,
   so the button landed in the wide `1.4fr` track meant for the bytes
   input. Fixed with a dedicated `.terminal-detach-sequence-row` flex
   layout.
3. **Attaching to an already-attached session caused violent screen
   flicker.** Root cause: no guard against nesting — attaching to session A
   from inside session A's own shell adds a second sink whose own output
   (a mirror of A) becomes part of what the first sink is already
   rendering, feeding back into itself. Fixed with the
   `WEBMANAGER_TERMINAL_SESSION` env var + startup check in `attachCmd`
   (see "Design" above) — initially scoped to same-name only, then widened
   to block nesting into *any* session once the repo owner pointed out a
   same-class loop is just as reachable through a 2-session cycle
   (A→B→A), not just direct self-attach.

## Deliberately not done here

- **No SSH auto-attach, no code-server terminal profile.** `attach <name>`
  is something you type; nothing forces it. Same precedent as the Font
  Manager for not writing code-server's settings.json.
- **No client-side name-charset validation** in the Terminal tab's own
  rename/create UI — pre-existing gap, unrelated to this feature.
- **Nesting is blocked, not chain-tracked.** A real chain-aware check
  (walk the full ancestor list, only refuse an actual cycle) would allow
  legitimate non-cyclic nesting (A into B into C), but needs threading the
  whole chain through the env var rather than just one name — skipped as
  unnecessary complexity for what's actually a rare, deliberately-blocked
  scenario; revisit only if someone has a real use case for it.

## Verification done by the agent (not a substitute for the checklist above)

- `go build`/`go vet`/`go test ./...` (including `attachcmd_test.go`'s 6
  `detachMatcher` cases) and the frontend `tsc -b`/`oxlint` all pass on
  every round of changes.
- Real container rebuild+redeploy after every change, `supervisorctl
  status` all RUNNING each time.
- A session opened over a raw WebSocket connection (simulating a browser
  "+" click) was joined via `bin/attach` (real pty via `script -qc`/
  `pty.fork()`) — confirmed same session (marker text + clear-prefix
  replay), concurrent multi-attach (held both connections open at once,
  neither got kicked), default Ctrl+] actually detaching, a reconfigured
  Ctrl+] detaching after settings PUT, `WEBMANAGER_TERMINAL_SESSION` set
  correctly on a real session's `/proc/<pid>/environ`, and the nesting
  guard refusing both same-name and different-name attach when that env
  var is present.
- None of this involved an actual human at an actual keyboard/SSH client —
  that's the checklist at the top of this doc.
