// Package termsession manages named, persistent PTY sessions for the web
// terminal (M2 — see webmanager/.claude/archive/terminal-plan-done.md's "영속 세션
// 토글" section). It's the server-owned session registry that decouples a PTY
// process's lifetime from any single WebSocket connection's lifetime,
// deliberately built by hand rather than shelling out to tmux/screen (repo
// owner's explicit call: "버그 많음").
//
// A Session is created the first time a name is used and keeps running
// after its WebSocket disconnects — reconnecting with the same name
// reattaches to the same PTY, replaying recent output (scrollback
// ringBuffer) first. "Ephemeral" (M1's original behavior, still used when a
// client connects without a session name) and "persistent" aren't different
// code paths here: every Session behaves the same way once created, and
// Pinned is just a bool on the record that exempts it from idle GC — see
// SetPinned. This package knows nothing about WebSocket (main package's
// handlers_terminal.go owns that); a Session's live output goes to whatever
// io.Writer is currently Attach-ed.
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
// codebase (e.g. internal/dind's container ID validation).
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
	sink           writerFunc
	sinkGen        uint64
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

func newSession(name, shell string, scrollbackBytes int, opts CreateOptions) (*Session, error) {
	cmd := exec.Command(shell)
	cmd.Dir = "/code"
	if opts.Cwd != "" {
		if info, err := os.Stat(opts.Cwd); err == nil && info.IsDir() {
			cmd.Dir = opts.Cwd
		}
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

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
// the scrollback ring buffer and, when a client is attached, forwarding the
// same bytes live. This is the actual "PTY lifetime decoupled from
// connection lifetime" mechanism the M2 design called for.
func (s *Session) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.ring.Write(chunk)
			s.mu.Lock()
			sink, gen := s.sink, s.sinkGen
			s.mu.Unlock()
			if sink != nil {
				if werr := sink(chunk); werr != nil {
					s.clearSinkIfCurrent(gen)
				}
			}
		}
		if err != nil {
			s.Close()
			return
		}
	}
}

// clearSinkIfCurrent removes the attached sink only if gen still matches the
// current attachment's generation — a Session that's already been Attach-ed
// to a newer connection by the time an old write fails must not have that
// newer attachment wiped out by the old one's error handling. sinkGen is
// bumped on every Attach/Detach specifically so this comparison works (Go
// func values themselves aren't comparable).
func (s *Session) clearSinkIfCurrent(gen uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sinkGen == gen {
		s.sink = nil
		s.lastAttachedAt = time.Now()
	}
}

// Attach makes sink the session's live output receiver, replays the current
// scrollback into it first (so a reattaching client sees what it missed),
// and returns a detach func the caller must call exactly once when its
// connection ends. Kicks (silently drops) any previously attached sink —
// "last connection wins", the simplest policy for the actual use case here
// (reattach after closing a tab), not concurrent shared viewing like tmux.
func (s *Session) Attach(sink writerFunc) (detach func(), scrollback []byte, err error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, nil, ErrSessionGone
	}
	s.sinkGen++
	gen := s.sinkGen
	s.sink = sink
	s.lastAttachedAt = time.Now()
	s.mu.Unlock()

	detach = func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.sinkGen == gen {
			s.sink = nil
			s.lastAttachedAt = time.Now()
		}
	}
	return detach, s.ring.Snapshot(), nil
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
	if s.sink != nil {
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
	return Info{
		Name:           s.Name,
		Pinned:         s.pinned,
		CreatedAt:      s.CreatedAt,
		LastAttachedAt: s.lastAttachedAt,
		Attached:       s.sink != nil,
		Pid:            pid,
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
	s.sink = nil
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
