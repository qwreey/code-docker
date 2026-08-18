// Package termsession manages named, persistent PTY sessions for the web
// terminal (M2 — see webmanager/.claude/archive/terminal-plan-done.md's "영속 세션
// 토글" section). It's the server-owned session registry that decouples a PTY
// process's lifetime from any single WebSocket connection's lifetime.
//
// A Session's PTY leader is a bare login shell (see newSession) — every
// webmanager Terminal tab is a plain, unwrapped PTY. Two earlier attempts at
// letting SSH/code-server reach a session too both got reverted the same day
// (webmanager/.claude/qa-request/attach-cli-plan-done.md's "History" section):
// wrapping every Session in tmux broke full-screen/alt-screen apps and glyph
// rendering (`claude`'s own TUI included) for ordinary use; a standalone,
// tmux-backed `bin/attach` tool decoupled from this Registry entirely
// avoided that, but wasn't actually what was wanted either — the ask was to
// reach an *already-running webmanager session*, not a separate parallel
// one. This is the third design: `webmanager --attach <name>` (see
// attachcmd.go in the main package) is a plain WebSocket client that talks
// to the exact same `GET /api/terminal?session=<name>` endpoint a browser
// tab does, so it's just another Attach-ed sink on the same Session — no
// tmux anywhere, no separate session, no capability ordinary Terminal-tab
// use doesn't already have. That's what makes Attach's multi-sink support
// below load-bearing now, not just a nicety: a browser tab and an
// external `--attach` client (or several of either) can be live on the same
// Session at once.
//
// A Session is created the first time a name is used and keeps running
// after its WebSocket disconnects — reconnecting with the same name
// reattaches to the same PTY, replaying recent output (scrollback
// ringBuffer, prefixed with a clear-screen sequence — see
// handlers_terminal.go's relayTerminalSession) first. "Ephemeral" (M1's
// original behavior, still used when a client connects without a session
// name) and "persistent" aren't different code paths here: every Session
// behaves the same way once created, and Pinned is just a bool on the
// record that exempts it from idle GC — see SetPinned. This package knows
// nothing about WebSocket (main package's handlers_terminal.go owns that);
// a Session's live output goes to every io.Writer currently Attach-ed.
package termsession

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

var (
	ErrInvalidName = errors.New("session name must be 1-64 chars of letters, digits, spaces, _, -, .")
	ErrSessionGone = errors.New("session no longer exists")
	ErrNameTaken   = errors.New("a session with that name already exists")
)

// nameRe is deliberately permissive (spaces allowed, this is a display
// label a human picks, never passed to exec.Command or a file path) but
// still bounded — mainly to keep it well-behaved as JSON/UI text, not a
// security boundary like the stricter identifier regexes elsewhere in this
// codebase (e.g. internal/dind's container ID validation). No longer
// constrained to tmux's session-name charset — see this package's doc
// comment, a registry-backed Session's name never reaches tmux at all now.
var nameRe = regexp.MustCompile(`^[\p{L}\p{N} _.-]{1,64}$`)

func ValidateName(name string) error {
	if !nameRe.MatchString(name) {
		return ErrInvalidName
	}
	return nil
}

// killGrace mirrors handlers_terminal.go's terminalKillGrace (M1) — same
// SIGHUP-then-SIGKILL grace period, duplicated rather than shared since M1's
// ephemeral path intentionally stays untouched/independent (see that file's
// doc comment).
const killGrace = 3 * time.Second

// Info is the JSON-safe snapshot returned by Registry.List.
type Info struct {
	Name           string    `json:"name"`
	Pinned         bool      `json:"pinned"`
	CreatedAt      time.Time `json:"createdAt"`
	LastAttachedAt time.Time `json:"lastAttachedAt"`
	Attached       bool      `json:"attached"`
	// Pid is the PTY-leader shell process's pid — exposed so the frontend
	// can cheaply answer "is a foreground program running in this tab"
	// itself (cross-referencing GET /api/processes' ppid tree) before
	// closing a session, rather than the backend needing its own process-
	// tree endpoint. 0 if the process somehow isn't available (defensive
	// only; pty.Start succeeding means cmd.Process is always set).
	Pid int `json:"pid"`
	// Cwd is the shell's live working directory, same resolution as Cwd()
	// below - empty string (not an error) if it can't be read, so one
	// session's /proc lookup failing never fails the whole List() response.
	Cwd string `json:"cwd"`
}

type Session struct {
	// Name is set at construction and read directly (no lock) by callers
	// that only ever see it once, e.g. Registry.GetOrCreate's caller. Once a
	// session can be renamed (see Registry.Rename), any read/write after
	// construction must go through currentName/rename below, which take mu -
	// info() already did, being the one place besides construction that
	// reads it.
	Name      string
	CreatedAt time.Time

	cmd  *exec.Cmd
	ptmx *os.File
	ring *ringBuffer

	// done is closed exactly once, when Close() actually runs (guarded by
	// the closed bool under mu, not a sync.Once, since they'd otherwise
	// need to be kept in sync anyway) — lets both the Registry (to forget
	// this session once it's gone) and an attached WS handler (to notice
	// the PTY died on its own, e.g. Ctrl+D, instead of hanging forever
	// waiting for client input that will never invalidate the connection)
	// react without polling.
	done chan struct{}

	mu             sync.Mutex
	pinned         bool
	closed         bool
	sinks          map[uint64]writerFunc
	nextSinkID     uint64
	lastAttachedAt time.Time
}

type writerFunc func(p []byte) error

// CreateOptions customizes a brand-new session at creation time only — see
// Registry.GetOrCreate, which ignores these when reattaching to a session
// that already exists (an already-running PTY's cwd/initial command can't
// be changed after the fact).
type CreateOptions struct {
	// Cwd, if set and it names an existing directory, is used as the
	// shell's starting directory instead of the "/code" default. An
	// invalid/nonexistent value falls back to the default rather than
	// failing the whole session — this is a convenience starting point, not
	// a security boundary (the shell it starts is already full
	// root-equivalent access).
	Cwd string
	// InitialCommand, if set, is written to the PTY right after the shell
	// starts, exactly as if the user had typed it themselves and pressed
	// Enter. No shell-escaping is needed since it's literal keystrokes into
	// an interactive shell, not a value substituted into another
	// exec.Command.
	InitialCommand string
}

// WEBMANAGER_TERMINAL_SESSION is set on every registry-backed session's own
// shell environment to that session's name, so a shell running inside one
// can tell it's inside a webmanager terminal session at all - specifically
// so `webmanager --attach` (main package's attachcmd.go) refuses to attach
// to *anything* from in there, not just the same session back into itself.
// A same-session attach is an obvious direct mirror loop; attaching to a
// different session is just as unsafe once nesting can chain (A into B,
// something inside B attaching back into A) - so nesting is blocked
// outright rather than only checking for the direct case. Any subprocess a
// shell spawns inherits it normally, same as $TERM, so this holds
// regardless of how many levels of subshell/script sit between the prompt
// and the actual `attach` invocation.
const terminalSessionEnvVar = "WEBMANAGER_TERMINAL_SESSION"

func newSession(name, shell string, scrollbackBytes int, opts CreateOptions) (*Session, error) {
	return newSessionCmd(name, shell, nil, []string{terminalSessionEnvVar + "=" + name}, scrollbackBytes, opts)
}

// NewStandalone starts a Session whose PTY leader is command/args directly
// (e.g. the `claude` binary itself), not a login shell — and, unlike every
// session created through a Registry, it's never added to any Registry's
// name->Session map, so it never appears in GET /api/terminal/sessions or
// competes with a user's own named tabs. Used by
// internal/claudecode's interactive-login flow (see that package), which
// needs a Session's full PTY lifecycle (Attach/Write/Resize/Close) for one
// dedicated, caller-owned command rather than a general-purpose shell — see
// root CLAUDE.md's webmanager section, "인터랙티브 온보딩" for why the
// interactive CLI itself has to be the process actually running, not a
// shell that merely typed `claude` as a first command. The caller alone is
// responsible for eventually calling Close() - nothing here schedules that
// automatically (though the PTY leader exiting on its own still marks the
// session Done() exactly like a Registry-owned one, so a caller can select
// on Done() instead of polling).
func NewStandalone(name, command string, args []string, scrollbackBytes int, opts CreateOptions) (*Session, error) {
	return newSessionCmd(name, command, args, nil, scrollbackBytes, opts)
}

func newSessionCmd(name, command string, args []string, extraEnv []string, scrollbackBytes int, opts CreateOptions) (*Session, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = "/code"
	if opts.Cwd != "" {
		if info, err := os.Stat(opts.Cwd); err == nil && info.IsDir() {
			cmd.Dir = opts.Cwd
		}
	}
	cmd.Env = append(append(os.Environ(), "TERM=xterm-256color"), extraEnv...)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("starting pty: %w", err)
	}

	now := time.Now()
	s := &Session{
		Name:           name,
		CreatedAt:      now,
		cmd:            cmd,
		ptmx:           ptmx,
		ring:           newRingBuffer(scrollbackBytes),
		sinks:          make(map[uint64]writerFunc),
		lastAttachedAt: now,
		done:           make(chan struct{}),
	}
	if opts.InitialCommand != "" {
		_, _ = ptmx.Write([]byte(strings.TrimRight(opts.InitialCommand, "\r\n") + "\n"))
	}
	go s.pump()
	return s, nil
}

// pump is the session's one long-lived reader: runs for the session's whole
// lifetime (not tied to any WebSocket), continuously draining the PTY into
// the scrollback ring buffer and forwarding the same bytes live to every
// currently Attach-ed sink. This is the actual "PTY lifetime decoupled from
// connection lifetime" mechanism the M2 design called for.
func (s *Session) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			// ring.Write and snapshotting the sink set must be one critical
			// section under the same lock Attach uses around its own "add
			// sink then snapshot the ring" - otherwise a chunk written here
			// can land in a newly-attaching client's scrollback snapshot AND
			// get forwarded to it live right after, producing visibly
			// duplicated output. See Attach's own comment for the other half
			// of this.
			s.mu.Lock()
			s.ring.Write(chunk)
			sinks := make(map[uint64]writerFunc, len(s.sinks))
			for id, sink := range s.sinks {
				sinks[id] = sink
			}
			s.mu.Unlock()
			for id, sink := range sinks {
				// sink is a caller-supplied write (ultimately a WebSocket
				// write) that's expected to carry its own bounded deadline -
				// see handlers_terminal.go's terminalWriteTimeout. Without
				// one, a client whose TCP receive window stalls (backgrounded
				// app, dead network with no RST/FIN) can block this call
				// indefinitely: pump() never returns to ptmx.Read, the PTY's
				// kernel buffer fills, and the shell itself blocks on its
				// next write - freezing the session for every future client,
				// not just the stalled one. It also defeats reapIdle, which
				// treats a non-empty sink set as "attached" and exempts it
				// from GC. A stalled/erroring sink only removes itself, never
				// the others, so one dead client can't take the rest down.
				if werr := sink(chunk); werr != nil {
					s.removeSink(id)
				}
			}
		}
		if err != nil {
			s.Close()
			return
		}
	}
}

// removeSink drops one sink by id — used both by pump() when a write to it
// errors and by the detach func Attach returns. Safe to call more than once
// for the same id (delete on an already-missing key is a no-op).
func (s *Session) removeSink(id uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sinks, id)
	s.lastAttachedAt = time.Now()
}

// Attach adds sink as one of the session's live output receivers, replays
// the current scrollback into it first (so a newly-attaching client sees
// what it missed), and returns a detach func the caller must call exactly
// once when its connection ends. Multiple sinks can be attached
// concurrently — a browser tab and one or more `webmanager --attach`
// clients (see attachcmd.go) all watching and typing into the same Session
// at once — attaching never kicks any other sink.
func (s *Session) Attach(sink writerFunc) (detach func(), scrollback []byte, err error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, nil, ErrSessionGone
	}
	id := s.nextSinkID
	s.nextSinkID++
	s.sinks[id] = sink
	s.lastAttachedAt = time.Now()
	// Snapshotting while still holding s.mu - the same lock pump() now holds
	// across its own "write to ring, then read sinks" step - is what makes
	// "does this chunk end up in the snapshot or in the live stream"
	// well-defined instead of a race: whichever of pump()'s write or this
	// Attach call takes the lock first determines it, with no window where
	// both (or neither) can happen. See pump()'s own comment.
	scrollback = s.ring.Snapshot()
	s.mu.Unlock()

	detach = func() { s.removeSink(id) }
	return detach, scrollback, nil
}

// Write sends client keystrokes to the PTY.
func (s *Session) Write(p []byte) (int, error) {
	return s.ptmx.Write(p)
}

// Resize forwards a terminal size change to the PTY.
func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

func (s *Session) SetPinned(pinned bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pinned = pinned
}

// currentName returns the session's live display name, safe to call
// concurrently with rename (unlike reading the Name field directly).
func (s *Session) currentName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Name
}

// rename updates the session's display name in place - same *Session, same
// PTY/goroutines/attached sink, just a new label. Only called by
// Registry.Rename, which holds its own lock across the map re-key and this
// call so the two never observe an inconsistent state.
func (s *Session) rename(name string) {
	s.mu.Lock()
	s.Name = name
	s.mu.Unlock()
}

// reapCheck reports everything Registry.reapIdle needs about this session in
// one locked read: whether it's exempt from GC (pinned), how long it's been
// since a client was last attached, and whether one is attached right now
// (in which case it's never idle).
func (s *Session) reapCheck(now time.Time) (pinned bool, idle time.Duration, attached bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sinks) > 0 {
		return s.pinned, 0, true
	}
	return s.pinned, now.Sub(s.lastAttachedAt), false
}

func (s *Session) info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	pid := 0
	if s.cmd.Process != nil {
		pid = s.cmd.Process.Pid
	}
	// Inlined rather than calling Cwd() - that method takes s.mu itself, and
	// mu isn't reentrant.
	cwd := ""
	if !s.closed && s.cmd.Process != nil {
		if link, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", s.cmd.Process.Pid)); err == nil {
			cwd = link
		}
	}
	return Info{
		Name:           s.Name,
		Pinned:         s.pinned,
		CreatedAt:      s.CreatedAt,
		LastAttachedAt: s.lastAttachedAt,
		Attached:       len(s.sinks) > 0,
		Pid:            pid,
		Cwd:            cwd,
	}
}

// Cwd resolves the shell process's live working directory via /proc/<pid>/cwd
// — unlike CreateOptions.Cwd (only meaningful at creation), this reflects
// wherever the shell has since `cd`'d to. Used by the "open in file manager
// at this session's current directory" frontend action.
func (s *Session) Cwd() (string, error) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed || s.cmd.Process == nil {
		return "", ErrSessionGone
	}
	return os.Readlink(fmt.Sprintf("/proc/%d/cwd", s.cmd.Process.Pid))
}

// Done returns a channel that's closed once this session has actually shut
// down (whether via pump() noticing PTY EOF — e.g. the shell exited via
// Ctrl+D — an explicit Registry.Remove, or idle GC). A currently-attached
// WS handler should select on this alongside its own connection read loop
// so it notices and tears itself down instead of sitting on a connection
// whose PTY is already dead.
func (s *Session) Done() <-chan struct{} {
	return s.done
}

// Close kills the shell (SIGHUP, then SIGKILL after killGrace, same as M1's
// killShell) and marks the session closed — idempotent, safe to call
// concurrently with pump() noticing PTY EOF on its own.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.sinks = nil
	close(s.done)
	s.mu.Unlock()

	_ = s.ptmx.Close()
	proc := s.cmd.Process
	if proc == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_ = s.cmd.Wait()
		close(done)
	}()
	_ = proc.Signal(syscall.SIGHUP)
	select {
	case <-done:
		return
	case <-time.After(killGrace):
	}
	_ = proc.Kill()
	<-done
}
