package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"github.com/coder/websocket"
	"golang.org/x/term"

	"webmanager/internal/authgate"
)

// attachCmd implements `webmanager --attach <name> [cwd]` - a plain
// WebSocket client for the exact same GET /api/terminal?session=<name>
// endpoint a browser tab uses (see handlers_terminal.go's
// handleNamedTerminal/relayTerminalSession), so it's just another sink on
// the same termsession.Session (see that package's Attach) rather than a
// separate mechanism. Meant to be run interactively - from SSH,
// code-server's integrated terminal, or typed inside an ordinary
// webmanager terminal tab - to reach an already-running (or brand new,
// same as clicking "+" in the Terminal tab) webmanager session from
// outside the browser. See webmanager/.claude/qa-request/attach-cli-plan-done.md
// for why this replaced two earlier tmux-based attempts.
//
// cwd is only honored the moment this actually creates a new session
// (GetOrCreate ignores it on reattach) - same rule the Terminal tab's own
// cwd/InitialCommand query params already follow.
func attachCmd(cfg Config, args []string) int {
	if len(args) < 1 || len(args) > 2 || args[0] == "" {
		fmt.Fprintln(os.Stderr, "usage: webmanager --attach <session-name> [start-dir]")
		return 1
	}
	name := args[0]

	// Refuse to attach at all when this process's own shell is already
	// running inside ANY webmanager terminal session - not just the exact
	// same name. Attaching to the same session back into itself is an
	// obvious mirror-loop, but attaching to a *different* one isn't safe
	// either: A attaching into B, with something inside B later attaching
	// back into A, is the same class of feedback loop one level removed -
	// "세션간 순환 중첩 나면 그것도 그것대로 터짐" (repo owner). Rather than
	// track and check the whole chain of ancestor sessions, nesting is
	// disallowed outright: detach (or close the browser tab) before
	// attaching to anything else. WEBMANAGER_TERMINAL_SESSION is set by
	// termsession.newSession (internal/termsession/termsession.go) on every
	// registry-backed session's shell, so this catches the mistake
	// regardless of whether the outer view is a browser tab or another
	// `attach`.
	if current := os.Getenv("WEBMANAGER_TERMINAL_SESSION"); current != "" {
		fmt.Fprintf(os.Stderr, "attach: already inside session %q - nested attach isn't supported (detach first, then attach to %q)\n", current, name)
		return 1
	}

	if !term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprintln(os.Stderr, "attach: stdin is not a terminal")
		return 1
	}

	baseURL := "http://" + cfg.Addr
	cookie, err := attachAuthenticate(baseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: %v\n", err)
		return 1
	}
	detachSeq := fetchDetachSequence(baseURL, cookie)

	query := url.Values{"session": {name}}
	if len(args) == 2 {
		query.Set("cwd", args[1])
	}
	wsURL := "ws://" + cfg.Addr + "/api/terminal?" + query.Encode()

	header := http.Header{}
	if cookie != "" {
		header.Set("Cookie", cookie)
	}
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: connecting to session %q: %v\n", name, err)
		return 1
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	return attachRelay(ctx, conn, detachSeq)
}

// defaultDetachSequence is Ctrl+] - telnet's own traditional escape
// character, chosen for the same reason telnet picked it: it's a single
// byte nothing else claims by default. Docker's own convention, Ctrl+P
// Ctrl+Q, was the first choice here but turned out to collide with
// code-server's own Ctrl+P (Quick Open) - inside that integrated terminal,
// Ctrl+P never reaches the PTY at all, so the sequence could never
// complete (confirmed live: this is why detach "wasn't working" there).
// Overridable per terminalsettings.Settings.DetachSequence (Docker's
// sequence, or anything else, is still one click away in the settings
// panel) since different people have different sequences already in their
// fingers (repo owner: "사람마다 손에 익은 시퀀스는 다르다") - just not
// this one as the default. Ctrl+[ was considered and rejected outright:
// it's the exact same byte (0x1b) as plain Escape, so it would fire on
// every Esc keypress in vim/readline/anything else - not offered as a
// preset, and the settings panel warns against it if typed manually.
var defaultDetachSequence = []byte{0x1d}

// fetchDetachSequence reads the configured detach byte sequence from
// GET /api/terminal/settings (same gated endpoint the browser's settings
// panel uses - cookie is whatever attachAuthenticate already obtained, "" if
// no password is configured). Any failure - network, decode, gate rejecting
// an unexpectedly-stale cookie - falls back to defaultDetachSequence with a
// warning rather than failing the whole attach, matching root CLAUDE.md's
// "non-essential setup degrades gracefully" convention; an empty configured
// value means the same thing (terminalsettings.Settings.DetachSequence's own
// "" -> built-in default rule).
func fetchDetachSequence(baseURL, cookie string) []byte {
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/terminal/settings", nil)
	if err != nil {
		return defaultDetachSequence
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: fetching detach sequence setting, using default (Ctrl+]): %v\n", err)
		return defaultDetachSequence
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "attach: fetching detach sequence setting, using default (Ctrl+]): unexpected status %d\n", resp.StatusCode)
		return defaultDetachSequence
	}

	var settings struct {
		DetachSequence string `json:"detachSequence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&settings); err != nil || settings.DetachSequence == "" {
		return defaultDetachSequence
	}
	return []byte(settings.DetachSequence)
}

// attachAuthenticate handles internal/authgate the same way the frontend's
// unlock modal does: checks GET /api/auth/status, and if a password is
// configured, prompts for it (stdin echo disabled) and exchanges it for the
// unlock cookie via POST /api/auth/unlock. Returns "" (no error) when no
// password is configured at all - the common case in this test environment
// and for anyone who hasn't opted into the gate.
func attachAuthenticate(baseURL string) (string, error) {
	resp, err := http.Get(baseURL + "/api/auth/status")
	if err != nil {
		return "", fmt.Errorf("checking auth status: %w", err)
	}
	defer resp.Body.Close()

	var status struct {
		Required bool `json:"required"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return "", fmt.Errorf("parsing auth status: %w", err)
	}
	if !status.Required {
		return "", nil
	}

	fmt.Fprint(os.Stderr, "webmanager password: ")
	pw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", fmt.Errorf("reading password: %w", err)
	}

	body, err := json.Marshal(map[string]string{"password": string(pw)})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/auth/unlock", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	unlockResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("unlocking: %w", err)
	}
	defer unlockResp.Body.Close()
	if unlockResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("incorrect password")
	}
	for _, c := range unlockResp.Cookies() {
		if c.Name == authgate.CookieName {
			return c.Name + "=" + c.Value, nil
		}
	}
	return "", fmt.Errorf("unlock succeeded but no cookie was returned")
}

// detachMatcher recognizes one configured byte sequence (typically 1-2
// bytes - a plain Ctrl+key, or two in a row like Docker's Ctrl+P Ctrl+Q)
// appearing consecutively in stdin, possibly spanning more than one
// os.Stdin.Read call. Deliberately not a general multi-pattern matcher (no
// KMP table, no support for detecting overlapping/multiple sequences) -
// every real detach sequence here is short enough that a plain
// how-many-bytes-matched-so-far counter, restarting on the very byte that
// broke the match, is simple and sufficient.
type detachMatcher struct {
	seq   []byte
	match int // how many leading bytes of seq are currently matched
}

// feed processes one incoming chunk. forward is what should actually reach
// the remote PTY - a byte that's only a tentative prefix of seq is held
// back until it's clear whether the sequence completes; if it doesn't, the
// held-back bytes are flushed into forward once the mismatch is seen. If
// seq completes, detached is true and anything left in chunk after that
// point is dropped (matches Docker's own attach: nothing typed in the same
// burst right after the escape leaks through either).
func (d *detachMatcher) feed(chunk []byte) (forward []byte, detached bool) {
	for _, b := range chunk {
		if b == d.seq[d.match] {
			d.match++
			if d.match == len(d.seq) {
				return forward, true
			}
			continue
		}
		if d.match > 0 {
			forward = append(forward, d.seq[:d.match]...)
			d.match = 0
		}
		if b == d.seq[0] {
			d.match = 1
			if d.match == len(d.seq) { // single-byte sequence
				return forward, true
			}
			continue
		}
		forward = append(forward, b)
	}
	return forward, false
}

// attachRelay puts the local terminal in raw mode and shuttles bytes
// between it and conn until either side closes, restoring the terminal
// before returning either way. detachSeq (see detachMatcher) detaches
// locally without touching the remote session at all once typed - it's
// just this process dropping its one sink, same as closing a browser tab -
// since there's no tmux-style prefix key to reserve a binding on here;
// closing the surrounding SSH connection or terminal window works exactly
// the same way.
func attachRelay(ctx context.Context, conn *websocket.Conn, detachSeq []byte) int {
	fd := int(os.Stdin.Fd())
	oldState, err := term.MakeRaw(fd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: entering raw mode: %v\n", err)
		return 1
	}
	defer term.Restore(fd, oldState)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sendResize := func() {
		cols, rows, err := term.GetSize(fd)
		if err != nil {
			return
		}
		msg, _ := json.Marshal(map[string]any{"type": "resize", "cols": cols, "rows": rows})
		_ = conn.Write(ctx, websocket.MessageText, msg)
	}
	sendResize()

	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	defer signal.Stop(winch)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-winch:
				sendResize()
			}
		}
	}()

	go func() {
		defer cancel()
		matcher := &detachMatcher{seq: detachSeq}
		buf := make([]byte, 4096)
		for {
			n, rerr := os.Stdin.Read(buf)
			if n > 0 {
				forward, detached := matcher.feed(buf[:n])
				if len(forward) > 0 {
					if werr := conn.Write(ctx, websocket.MessageBinary, forward); werr != nil {
						return
					}
				}
				if detached {
					fmt.Fprintln(os.Stderr, "\r\n[detached]")
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	for {
		msgType, data, rerr := conn.Read(ctx)
		if rerr != nil {
			break
		}
		if msgType == websocket.MessageBinary {
			_, _ = os.Stdout.Write(data)
		}
	}
	return 0
}
