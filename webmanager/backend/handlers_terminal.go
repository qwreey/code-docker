package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
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
		s.handleNamedTerminal(context.Background(), conn, name, opts)
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

// handleNamedTerminal is the M2 path: reattach to (or create) a
// termsession.Session by name, replay its scrollback, then relay this
// connection's input/output exactly like handleTerminal's M1 loop — except
// the PTY itself is owned by the Session, not this function, so it keeps
// running after this connection ends.
func (s *Server) handleNamedTerminal(ctx context.Context, conn *websocket.Conn, name string, opts termsession.CreateOptions) {
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

	relayTerminalSession(ctx, conn, sess, name)
}

// relayTerminalSession shuttles an already-obtained *termsession.Session's
// PTY output to conn as binary frames, and conn's binary frames (keystrokes)
// / "resize" control messages back to the PTY, until either side closes.
// Shared by handleNamedTerminal (session obtained via the Registry) and
// handleClaudeInteractiveLoginTerminal (session obtained via
// claudecode.InteractiveLoginManager, never Registry-tracked) - the relay
// logic itself doesn't care which. logLabel is only used for log lines.
func relayTerminalSession(ctx context.Context, conn *websocket.Conn, sess *termsession.Session, logLabel string) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sink := func(p []byte) error {
		return writeWithTimeout(ctx, conn, p)
	}
	detach, scrollback, err := sess.Attach(sink)
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

	if len(scrollback) > 0 {
		if werr := writeWithTimeout(ctx, conn, scrollback); werr != nil {
			return
		}
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

	relayTerminalSession(context.Background(), conn, sess, "claude-interactive-login")
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
