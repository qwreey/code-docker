package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"webmanager/internal/termsession"
)

// terminalReadBufferSize is the chunk size used when copying PTY output to
// the WebSocket connection.
const terminalReadBufferSize = 32 * 1024

// terminalKillGrace is how long a SIGHUP'd shell gets to exit on its own
// before handleTerminal escalates to SIGKILL.
const terminalKillGrace = 3 * time.Second

// terminalWriteTimeout bounds every WebSocket write of PTY output. Without
// it, a client whose TCP receive window stalls (backgrounded app, dead
// network with no RST/FIN) can block conn.Write indefinitely - for the M1
// loop that just leaks this connection's goroutines until an OS-level TCP
// timeout; for a termsession.Session's sink (M2, see handleNamedTerminal)
// it's worse, since pump() calls the sink synchronously and a stuck write
// stalls PTY draining for every future client of that named session, not
// just the stalled one.
const terminalWriteTimeout = 10 * time.Second

// scrollbackChunkBytes bounds each individual WebSocket message used to
// replay a session's scrollback on attach. A WebSocket client's read limit
// applies per *message*, and coder/websocket - the library
// `webmanager --attach` uses (see attachcmd.go) - defaults that limit to
// 32KiB, while the scrollback buffer holds up to
// WEBMANAGER_TERMINAL_SESSION_SCROLLBACK_BYTES (256KiB by default). Sent as
// one message, the replay therefore made that client abort the connection
// with StatusMessageTooBig the moment it attached to any session that had
// ever produced more than 32KiB of output - and silently, since it surfaced
// as a plain read error and exit code 0. The visible symptom was `attach
// <a session you'd actually been working in>` dropping straight back to the
// outer shell while `attach <brand new name>` (empty scrollback, replay
// skipped entirely) worked perfectly. Live output was never affected:
// pump() reads at most terminalReadBufferSize per chunk, already under the
// limit. Kept well below 32KiB rather than exactly at it so any client's
// own default has headroom too.
const scrollbackChunkBytes = 16 * 1024

// terminalControlMessage is the JSON shape of text WebSocket frames sent by
// the client. M1 only defines "resize"; unknown types are ignored so the
// protocol can grow without breaking older clients.
type terminalControlMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// handleTerminal upgrades the request to a WebSocket and relays a single
// ephemeral PTY session for the lifetime of that connection: on connect it
// spawns the container's login shell, then shuttles PTY output to the client
// as binary frames and client input back to the PTY, until the WebSocket
// closes — at which point the shell is killed. No session persistence, no
// reconnect (M1 scope; see webmanager/.claude/terminal-plan.md).
//
// SECURITY: this endpoint opens an unauthenticated, interactive root shell
// to anyone who can reach webmanager. There is no login of its own — same
// trust model as the rest of webmanager (the fronting reverse proxy's
// forward-auth is the only real gate, see README's "보안 (로그인)") — but
// this is the single most powerful capability webmanager exposes, on par
// with the dind Docker API. Do not expose webmanager's port directly to an
// untrusted network.
func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	// Deliberately not setting InsecureSkipVerify: Accept's default
	// same-origin check (Origin host must match the request Host) stays
	// on. This doesn't replace real auth (there isn't any for M1, see
	// above) — it just stops an unrelated site's page from opening a
	// WebSocket to this endpoint through a victim's browser.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("terminal: websocket accept failed: %v", err)
		return
	}

	// M2: a named session (see internal/termsession) — created on first use,
	// survives this connection closing, reattached to on a later connection
	// with the same name. Omitting ?session= keeps the exact M1 behavior
	// below (always a brand new PTY, killed the moment this connection
	// closes) — the two paths are kept fully separate rather than routing
	// M1 through the registry with a throwaway name, so M1's already-tested
	// behavior can't regress from M2 changes.
	if name := r.URL.Query().Get("session"); name != "" {
		// cwd/cmd are only meaningful the moment this name is first created
		// (see termsession.Registry.GetOrCreate) — a plain tab-switch
		// reconnect to an already-running session just omits them and they
		// no-op here too, since GetOrCreate ignores opts on that path.
		opts := termsession.CreateOptions{
			Cwd:            r.URL.Query().Get("cwd"),
			InitialCommand: r.URL.Query().Get("cmd"),
		}
		// context.Background(), not r.Context(): matches the ephemeral path
		// below (which does the same for the same reason) — this connection
		// can legitimately outlive whatever timeout semantics the request
		// context might carry, since the handler blocks here for the
		// connection's whole lifetime rather than returning immediately.
		s.handleNamedTerminal(context.Background(), conn, name, opts, parseAttachSize(r))
		return
	}

	shell := rootLoginShell()
	cmd := exec.Command(shell)
	cmd.Dir = "/code"
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Printf("terminal: failed to start pty (shell=%s): %v", shell, err)
		_ = conn.Close(websocket.StatusInternalError, "failed to start shell")
		return
	}
	log.Printf("terminal: session started shell=%s pid=%d", shell, cmd.Process.Pid)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// teardown is called from whichever side (PTY EOF/error, or WS
	// close/error) notices the session is over first. sync.Once makes it
	// safe to call from both the relay goroutine and the main loop below
	// without double-closing anything.
	var teardownOnce sync.Once
	teardown := func() {
		teardownOnce.Do(func() {
			cancel()
			_ = ptmx.Close()
			killShell(cmd)
		})
	}
	defer teardown()

	// PTY output -> WS binary frames.
	go func() {
		defer teardown()
		buf := make([]byte, terminalReadBufferSize)
		for {
			n, rerr := ptmx.Read(buf)
			if n > 0 {
				werr := writeWithTimeout(ctx, conn, buf[:n])
				if werr != nil {
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	// WS input (binary = keystrokes, text = JSON control messages) -> PTY.
readLoop:
	for {
		msgType, data, rerr := conn.Read(ctx)
		if rerr != nil {
			break readLoop
		}
		switch msgType {
		case websocket.MessageBinary:
			if _, werr := ptmx.Write(data); werr != nil {
				break readLoop
			}
		case websocket.MessageText:
			var ctl terminalControlMessage
			if jerr := json.Unmarshal(data, &ctl); jerr != nil {
				log.Printf("terminal: ignoring malformed control message: %v", jerr)
				continue
			}
			if ctl.Type != "resize" || ctl.Cols == 0 || ctl.Rows == 0 {
				continue
			}
			if serr := pty.Setsize(ptmx, &pty.Winsize{Rows: ctl.Rows, Cols: ctl.Cols}); serr != nil {
				log.Printf("terminal: resize failed: %v", serr)
			}
		}
	}

	_ = conn.Close(websocket.StatusNormalClosure, "")
}

// attachSize is the terminal size an attaching client reports up front, via
// ?cols=/?rows= on the WebSocket URL. Zero means the client didn't say (an
// older frontend, or the `attach` CLI), in which case the session keeps
// whatever size it already had.
type attachSize struct {
	Cols uint16
	Rows uint16
}

func (a attachSize) known() bool { return a.Cols > 0 && a.Rows > 0 }

// parseAttachSize reads ?cols=/?rows= off r. Anything missing, unparseable
// or out of range is reported as "not told" rather than an error — a bad
// size is never worth refusing a terminal connection over.
func parseAttachSize(r *http.Request) attachSize {
	q := r.URL.Query()
	return attachSize{Cols: parseTerminalDimension(q.Get("cols")), Rows: parseTerminalDimension(q.Get("rows"))}
}

func parseTerminalDimension(raw string) uint16 {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 || n > math.MaxUint16 {
		return 0
	}
	return uint16(n)
}

// nudgeRepaint resizes the PTY one row down and straight back, to make the
// foreground application redraw its whole screen.
//
// Needed because a scrollback replay is only ever an approximation: the
// ring buffer holds raw bytes, not parsed screen state, so a full-screen
// application's absolute cursor moves replay into a screen that isn't in
// the state they were written for. The client's real size is already
// applied before the snapshot (see relayTerminalSession), but TIOCSWINSZ
// only raises SIGWINCH when the size actually *changes* — so a client
// reattaching at the size it left gets no signal at all, which is exactly
// the common case, and exactly when users were nudging the browser window
// by hand to un-garble the display.
func nudgeRepaint(sess *termsession.Session, size attachSize, logLabel string) {
	if !size.known() || size.Rows < 2 {
		return
	}
	if err := sess.Resize(size.Cols, size.Rows-1); err != nil {
		log.Printf("terminal: session %q: repaint nudge failed: %v", logLabel, err)
		return
	}
	if err := sess.Resize(size.Cols, size.Rows); err != nil {
		log.Printf("terminal: session %q: repaint nudge restore failed: %v", logLabel, err)
	}
}

// handleNamedTerminal is the M2 path: reattach to (or create) a
// termsession.Session by name, replay its scrollback, then relay this
// connection's input/output exactly like handleTerminal's M1 loop — except
// the PTY itself is owned by the Session, not this function, so it keeps
// running after this connection ends.
func (s *Server) handleNamedTerminal(ctx context.Context, conn *websocket.Conn, name string, opts termsession.CreateOptions, size attachSize) {
	sess, err := s.termSessions.GetOrCreate(name, opts)
	if err != nil {
		log.Printf("terminal: session %q: %v", name, err)
		status := websocket.StatusInternalError
		if errors.Is(err, termsession.ErrInvalidName) {
			status = websocket.StatusPolicyViolation
		}
		_ = conn.Close(status, err.Error())
		return
	}

	relayTerminalSession(ctx, conn, sess, name, size)
}

// relayTerminalSession shuttles an already-obtained *termsession.Session's
// PTY output to conn as binary frames, and conn's binary frames (keystrokes)
// / "resize" control messages back to the PTY, until either side closes.
// Shared by handleNamedTerminal (session obtained via the Registry) and
// handleClaudeInteractiveLoginTerminal (session obtained via
// claudecode.InteractiveLoginManager, never Registry-tracked) - the relay
// logic itself doesn't care which. logLabel is only used for log lines.
func relayTerminalSession(ctx context.Context, conn *websocket.Conn, sess *termsession.Session, logLabel string, size attachSize) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Apply the attaching client's size before the scrollback snapshot
	// below, not after. The ring buffer holds raw bytes recorded at
	// whatever size the PTY had when they were produced, so replaying them
	// into a differently-sized terminal renders garbage — absolute cursor
	// moves and box drawing land in the wrong columns. Resizing first gives
	// the foreground application a SIGWINCH to repaint from, and that
	// repaint then lands after the replay instead of before it. The
	// client's own "resize" control message can't do this job: it isn't
	// read until the readLoop below, which only starts once the replay has
	// already been written.
	if size.known() {
		if rerr := sess.Resize(size.Cols, size.Rows); rerr != nil {
			log.Printf("terminal: session %q: initial resize failed: %v", logLabel, rerr)
		}
	}

	sink := func(p []byte) error {
		return writeWithTimeout(ctx, conn, p)
	}
	detach, replay, err := sess.Attach(sink)
	if err != nil {
		log.Printf("terminal: session %q: attach failed: %v", logLabel, err)
		_ = conn.Close(websocket.StatusInternalError, err.Error())
		return
	}
	defer detach()

	// If the session dies on its own (PTY EOF — e.g. the shell exited via
	// Ctrl+D — or an explicit Remove/idle-GC elsewhere), cancel ctx so the
	// conn.Read below unblocks and this connection actually closes instead
	// of hanging open forever waiting for client input that will never
	// come. The ctx.Done() branch lets this goroutine exit once the normal
	// path's own `defer cancel()` fires, so it doesn't leak past this
	// connection's lifetime.
	go func() {
		select {
		case <-sess.Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	if len(replay.Preamble) > 0 || len(replay.Scrollback) > 0 {
		if werr := writeScrollback(ctx, conn, replay); werr != nil {
			return
		}
		nudgeRepaint(sess, size, logLabel)
	}

readLoop:
	for {
		msgType, data, rerr := conn.Read(ctx)
		if rerr != nil {
			break readLoop
		}
		switch msgType {
		case websocket.MessageBinary:
			if _, werr := sess.Write(data); werr != nil {
				break readLoop
			}
		case websocket.MessageText:
			var ctl terminalControlMessage
			if jerr := json.Unmarshal(data, &ctl); jerr != nil {
				log.Printf("terminal: session %q: ignoring malformed control message: %v", logLabel, jerr)
				continue
			}
			if ctl.Type != "resize" || ctl.Cols == 0 || ctl.Rows == 0 {
				continue
			}
			if serr := sess.Resize(ctl.Cols, ctl.Rows); serr != nil {
				log.Printf("terminal: session %q: resize failed: %v", logLabel, serr)
			}
		}
	}

	_ = conn.Close(websocket.StatusNormalClosure, "")
}

// handleClaudeInteractiveLoginTerminal upgrades to a WebSocket and relays
// the interactive `claude` onboarding session started by a prior
// POST /api/claude/login/interactive/start (see
// internal/claudecode.InteractiveLoginManager and handlers_claude.go) - same
// relay as a named terminal session, just sourced from that manager instead
// of s.termSessions. A 404 (unknown/superseded/expired id) closes the
// socket immediately with a policy-violation-shaped status so the frontend
// can tell "start over" apart from a normal disconnect.
func (s *Server) handleClaudeInteractiveLoginTerminal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	sess, ok := s.interactiveLoginMgr.Session(id)
	if !ok {
		http.Error(w, "unknown or expired interactive login session", http.StatusNotFound)
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("claude interactive login: websocket accept failed: %v", err)
		return
	}

	relayTerminalSession(context.Background(), conn, sess, "claude-interactive-login", parseAttachSize(r))
}

// writeScrollback replays a session into a freshly-attached connection: the
// mode preamble first, then a clear+home, then the scrollback buffer itself
// in scrollbackChunkBytes-sized messages.
//
// The preamble goes first because it is what re-enters the alternate screen
// buffer (see termsession/modes.go) — everything after it has to be drawn
// into the buffer the application actually believes it is drawing into, and
// entering the alt buffer clears it, so doing it after the replay would wipe
// what was just replayed.
//
// The clear is needed because the ring buffer is raw bytes, not parsed
// terminal state, so relative cursor-movement escapes in it only render
// correctly against a known-blank starting screen. The browser frontend
// already gets that for free (term.reset() before reconnecting - see
// Terminal.tsx), but webmanager --attach (attachcmd.go) hands this straight
// to a real terminal with whatever was on it before, so it has to happen
// here, covering both callers identically.
//
// The chunking is what keeps the replay under a client's per-message read
// limit - see scrollbackChunkBytes for the bug that caused. Message order
// on a single WebSocket connection is guaranteed, so splitting is
// indistinguishable from one big write on the receiving end.
func writeScrollback(ctx context.Context, conn *websocket.Conn, replay termsession.Replay) error {
	if err := writeWithTimeout(ctx, conn, append(append([]byte(nil), replay.Preamble...), "\x1b[2J\x1b[H"...)); err != nil {
		return err
	}
	scrollback := replay.Scrollback
	for off := 0; off < len(scrollback); off += scrollbackChunkBytes {
		end := off + scrollbackChunkBytes
		if end > len(scrollback) {
			end = len(scrollback)
		}
		if err := writeWithTimeout(ctx, conn, scrollback[off:end]); err != nil {
			return err
		}
	}
	return nil
}

// writeWithTimeout writes p to conn as a binary frame, bounded by
// terminalWriteTimeout - see that constant's doc comment for why an
// unbounded conn.Write is a real problem here, not just defensive
// programming. ctx is still the parent (cancelled on connection/session
// teardown), so either cancellation reason ends the write promptly.
func writeWithTimeout(ctx context.Context, conn *websocket.Conn, p []byte) error {
	wctx, cancel := context.WithTimeout(ctx, terminalWriteTimeout)
	defer cancel()
	return conn.Write(wctx, websocket.MessageBinary, p)
}

// killShell asks the shell to exit gracefully (SIGHUP) and escalates to
// SIGKILL if it hasn't exited within terminalKillGrace. cmd.Wait() always
// runs to completion in its own goroutine so the process is reaped and
// never left behind as a zombie, regardless of which path exits it.
func killShell(cmd *exec.Cmd) {
	proc := cmd.Process
	if proc == nil {
		return
	}

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()

	_ = proc.Signal(syscall.SIGHUP)

	select {
	case <-done:
		return
	case <-time.After(terminalKillGrace):
	}

	_ = proc.Kill()
	<-done
}

// rootLoginShell reads root's login shell straight from /etc/passwd (field
// index 6, 0-indexed) rather than re-parsing config/shell.*: chsh already
// baked the resolved choice in at image build time (see root Dockerfile),
// so /etc/passwd is the single authoritative source at runtime. Falls back
// to /bin/bash (logging a warning) if the file can't be read or parsed —
// this is a convenience default, not something that should ever fail the
// whole endpoint.
func rootLoginShell() string {
	const fallback = "/bin/bash"

	data, err := os.ReadFile("/etc/passwd")
	if err != nil {
		log.Printf("terminal: reading /etc/passwd failed, falling back to %s: %v", fallback, err)
		return fallback
	}

	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "root:") {
			continue
		}
		fields := strings.Split(line, ":")
		if len(fields) < 7 {
			log.Printf("terminal: root entry in /etc/passwd has too few fields, falling back to %s", fallback)
			return fallback
		}
		shell := strings.TrimSpace(fields[6])
		if shell == "" {
			log.Printf("terminal: root entry in /etc/passwd has an empty shell field, falling back to %s", fallback)
			return fallback
		}
		return shell
	}

	log.Printf("terminal: no root entry found in /etc/passwd, falling back to %s", fallback)
	return fallback
}
