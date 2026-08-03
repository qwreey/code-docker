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
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

var (
	ErrInvalidName = errors.New("session name must be 1-64 chars of letters, digits, spaces, _, -, .")
	ErrSessionGone = errors.New("session no longer exists")
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
}

type Session struct {
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

func newSession(name, shell string, scrollbackBytes int) (*Session, error) {
	cmd := exec.Command(shell)
	cmd.Dir = "/code"
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
	return Info{
		Name:           s.Name,
		Pinned:         s.pinned,
		CreatedAt:      s.CreatedAt,
		LastAttachedAt: s.lastAttachedAt,
		Attached:       s.sink != nil,
	}
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
