package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/term"

	"webmanager/internal/atomicfile"
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
	cookie, err := attachAuthenticate(baseURL, cfg.AttachCookiePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "attach: %v\n", err)
		return 1
	}
	detachSeq := fetchDetachSequence(baseURL, cookie)

	// Say what this attach is about to do, before the connection replaces
	// the screen. Landing silently in *a* shell, with no way to tell "joined
	// the session you meant" from "created a brand new one under a name
	// nothing had", is what made a real mismatch take a whole debugging
	// session to pin down - and `attach <name with a space>` splitting into
	// name + start-dir makes creating-instead-of-joining easy to hit by
	// accident. The detach key rides on the same line because it's the other
	// thing there's no way to discover from inside: it's configurable (see
	// fetchDetachSequence), and a wrong guess at it leaves Ctrl+D - which
	// exits the shell and so destroys the session for the browser tab too -
	// as the only exit that appears to work.
	detachHint := describeDetachSequence(detachSeq)
	switch exists, known := sessionExists(baseURL, cookie, name); {
	case !known:
		fmt.Fprintf(os.Stderr, "attach: connecting to session %q (%s to detach)\n", name, detachHint)
	case exists:
		fmt.Fprintf(os.Stderr, "attach: joining existing session %q (%s to detach)\n", name, detachHint)
	default:
		fmt.Fprintf(os.Stderr, "attach: creating new session %q (%s to detach)\n", name, detachHint)
	}

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
	// coder/websocket defaults to a 32KiB per-message read limit, which the
	// server's scrollback replay used to exceed on any session with real
	// history (see handlers_terminal.go's scrollbackChunkBytes for the whole
	// story). That replay is chunked now, so this is belt-and-braces: it
	// keeps a client from silently dying on any future server-side write
	// that grows past the default. The peer here is this container's own
	// webmanager, which is already handing us a root shell, so a generous
	// bound costs nothing in trust - it's only here so a runaway message
	// can't grow the buffer without limit.
	conn.SetReadLimit(8 << 20)
	defer conn.Close(websocket.StatusNormalClosure, "")

	return attachRelay(ctx, conn, detachSeq, name)
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

// saveAttachCookie caches a freshly-obtained unlock cookie so the CLI paths
// that have no terminal to prompt on can reuse it - today just
// `webmanager --list-sessions`, which is what `attach`'s shell completion
// shells out to, and which therefore offered *nothing* whenever the
// password gate was on. That silence is worse than it sounds: the default
// session names contain a space ("세션 1"), so with no completion to quote
// them, `attach 세션 1` splits into name + start-dir and quietly creates a
// session named "세션" instead of joining the one meant.
//
// No expiry bookkeeping here on purpose: the token carries its own signed
// issue time, the gate rejects it past its TTL, and webmanager's HMAC
// secret is regenerated on every restart - so a stale file simply stops
// working (completion goes quiet again until the next attach), it can never
// grant more than the gate itself would. Every failure is ignored: this is
// a convenience cache, never a reason to fail an attach that already
// authenticated successfully.
func saveAttachCookie(path, cookie string) {
	if path == "" {
		return
	}
	_ = atomicfile.Write(path, []byte(cookie+"\n"), 0o600, 0o755)
}

// loadAttachCookie reads back whatever saveAttachCookie last stored. An
// empty string means "nothing usable" - missing file, unreadable, empty -
// and every caller treats that the same as having no cookie at all.
func loadAttachCookie(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// sessionExists reports whether name is already a live session, so the
// banner above can say "joining" instead of "creating". known is false when
// that couldn't be determined at all (network error, non-200 - e.g. an
// unexpectedly stale cookie - or an unparseable body), in which case the
// caller says less rather than failing the attach, same graceful-degrade
// rule as fetchDetachSequence.
func sessionExists(baseURL, cookie, name string) (exists, known bool) {
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/terminal/sessions", nil)
	if err != nil {
		return false, false
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var sessions []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		return false, false
	}
	for _, s := range sessions {
		if s.Name == name {
			return true, true
		}
	}
	return false, true
}

// describeDetachSequence renders a byte sequence the way a human types it
// ("Ctrl+]", or "Ctrl+P Ctrl+Q" for Docker's two-key one), for the banner
// and the detach message. Anything that isn't a C0 control byte is printed
// as-is so a custom sequence never renders as a lie.
func describeDetachSequence(seq []byte) string {
	parts := make([]string, 0, len(seq))
	for _, b := range seq {
		switch {
		case b < 0x20:
			parts = append(parts, fmt.Sprintf("Ctrl+%c", b+0x40))
		case b == 0x7f:
			parts = append(parts, "Backspace")
		default:
			parts = append(parts, string(rune(b)))
		}
	}
	return strings.Join(parts, " ")
}

// attachAuthenticate handles internal/authgate the same way the frontend's
// unlock modal does: checks GET /api/auth/status, and if a password is
// configured, prompts for it (stdin echo disabled) and exchanges it for the
// unlock cookie via POST /api/auth/unlock. Returns "" (no error) when no
// password is configured at all - the common case in this test environment
// and for anyone who hasn't opted into the gate. A successful unlock is
// cached via saveAttachCookie for the CLI paths that can't prompt.
func attachAuthenticate(baseURL, cookiePath string) (string, error) {
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
			cookie := c.Name + "=" + c.Value
			saveAttachCookie(cookiePath, cookie)
			return cookie, nil
		}
	}
	return "", fmt.Errorf("unlock succeeded but no cookie was returned")
}

// detachMatcher recognizes the configured detach sequence in the stdin
// byte stream, holding back any bytes that are still a live prefix of it so
// a partial match never leaks through to the remote PTY.
//
// It matches several *encodings* of the same key press, not just the raw
// bytes, because a modern shell reconfigures the terminal's keyboard
// reporting out from under us: fish (and other apps) enable the kitty
// keyboard protocol or xterm's modifyOtherKeys while at their prompt, and
// in those modes Ctrl+] arrives as "\x1b[93;5u" or "\x1b[27;5;93~" rather
// than the plain 0x1d byte. That was a real, and thoroughly confusing,
// failure: Ctrl+] did nothing at the shell prompt but detached perfectly
// once a plain foreground program (`cat -v`) was running, because that
// program's start restores the legacy encoding. See detachCandidates.
//
// Deliberately still not a general multi-pattern engine (no KMP table): the
// candidate set is tiny and short, so a naive "is what I'm holding a
// complete match / still a prefix of something" check per byte is simple
// and fast enough.
type detachMatcher struct {
	// keys[i] holds every encoding key i might arrive as - see
	// detachCandidates. Matching is per key, not over one flat byte string,
	// so a two-key sequence works even when its keys arrive in different
	// encodings and different reads.
	keys    [][][]byte
	matched []byte // raw bytes of the leading keys matched so far
	keyIdx  int    // how many keys are matched
	held    []byte // bytes of a partially matched current key
}

func newDetachMatcher(seq []byte) *detachMatcher {
	return &detachMatcher{keys: detachCandidates(seq)}
}

// detachCandidates expands each byte of a configured sequence into every
// encoding a terminal might send for that key press: the literal byte,
// plus - for a C0 control byte - the kitty keyboard protocol's CSI u form
// and xterm's modifyOtherKeys form for the same Ctrl+key. The key number in
// both is the *unshifted* character the control byte stands for (0x1d ->
// ']' = 93, 0x01 -> 'a' = 97); 5 is the Ctrl modifier encoding both
// protocols share.
func detachCandidates(seq []byte) [][][]byte {
	keys := make([][][]byte, 0, len(seq))
	for _, b := range seq {
		alts := [][]byte{{b}}
		if b >= 0x01 && b < 0x20 {
			key := int(b) + 0x40
			if key >= 'A' && key <= 'Z' {
				key += 'a' - 'A'
			}
			alts = append(alts,
				[]byte(fmt.Sprintf("\x1b[%d;5u", key)),
				[]byte(fmt.Sprintf("\x1b[27;5;%d~", key)),
			)
		}
		keys = append(keys, alts)
	}
	return keys
}

func (d *detachMatcher) matchesKey() bool {
	for _, alt := range d.keys[d.keyIdx] {
		if bytes.Equal(d.held, alt) {
			return true
		}
	}
	return false
}

func (d *detachMatcher) prefixOfKey() bool {
	for _, alt := range d.keys[d.keyIdx] {
		if len(d.held) < len(alt) && bytes.HasPrefix(alt, d.held) {
			return true
		}
	}
	return false
}

func (d *detachMatcher) reset() {
	d.matched = d.matched[:0]
	d.held = d.held[:0]
	d.keyIdx = 0
}

// feed processes one incoming chunk. forward is what should actually reach
// the remote PTY - bytes that are only a tentative prefix of the sequence
// are held back until it's clear whether it completes; if it doesn't, they
// are flushed into forward, and matching restarts at the very byte that
// broke the match (so "Ctrl+P Ctrl+P Ctrl+Q" still detaches on the second
// pair). If the sequence completes, detached is true and anything left in
// chunk after that point is dropped - same as Docker's own attach, where
// nothing typed in the same burst right after the escape leaks through
// either.
//
// A half-typed *escape* encoding is only ever held within a single chunk:
// terminals emit a key's whole escape sequence in one write, while a human
// typing a two-key sequence lands in separate reads. Holding a lone ESC
// across reads instead would make the Escape key itself feel stuck until
// the next keystroke - unacceptable in vim and anything else that treats
// Escape as an immediate action.
func (d *detachMatcher) feed(chunk []byte) (forward []byte, detached bool) {
	forward, detached = d.feedBytes(chunk)
	if detached {
		return forward, true
	}
	if len(d.held) > 0 && d.held[0] == 0x1b {
		forward = append(forward, d.held...)
		d.held = d.held[:0]
	}
	return forward, false
}

func (d *detachMatcher) feedBytes(chunk []byte) (forward []byte, detached bool) {
	for _, b := range chunk {
		d.held = append(d.held, b)
		if d.matchesKey() {
			d.matched = append(d.matched, d.held...)
			d.held = d.held[:0]
			d.keyIdx++
			if d.keyIdx == len(d.keys) {
				d.reset()
				return forward, true
			}
			continue
		}
		if d.prefixOfKey() {
			continue
		}

		// Mismatch: everything held so far was ordinary input after all.
		// Flush its first byte, then re-run the rest through a reset
		// matcher so a new match can start inside it. Bounded recursion -
		// the re-fed slice is always strictly shorter than what produced
		// it.
		stale := append(append([]byte(nil), d.matched...), d.held...)
		d.reset()
		forward = append(forward, stale[0])
		refed, det := d.feedBytes(stale[1:])
		forward = append(forward, refed...)
		if det {
			return forward, true
		}
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
func attachRelay(ctx context.Context, conn *websocket.Conn, detachSeq []byte, name string) int {
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

	// Set before the detach message is printed (and so before the deferred
	// cancel below unblocks the read loop), so the loop's own exit message
	// can tell a deliberate detach apart from the session ending underneath
	// it - Ctrl+D exits the shell, which ends the session for every other
	// client including the browser tab, and that difference was invisible.
	var detachedByUser atomic.Bool
	// ATTACH_DEBUG_LOG=<path> appends a hex dump of everything read from
	// stdin. It exists because "which bytes did the terminal actually send
	// for that key" is otherwise unanswerable from inside a raw-mode relay,
	// and that question is exactly what a detach key that silently does
	// nothing comes down to (see detachCandidates). Failing to open the
	// file is ignored: a diagnostic switch must never break the attach.
	var debugLog *os.File
	if path := os.Getenv("ATTACH_DEBUG_LOG"); path != "" {
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			debugLog = f
			defer f.Close()
		}
	}

	go func() {
		defer cancel()
		matcher := newDetachMatcher(detachSeq)
		buf := make([]byte, 4096)
		for {
			n, rerr := os.Stdin.Read(buf)
			if n > 0 {
				if debugLog != nil {
					fmt.Fprintf(debugLog, "%s stdin % x\n", time.Now().Format(time.RFC3339Nano), buf[:n])
				}
				forward, detached := matcher.feed(buf[:n])
				if len(forward) > 0 {
					if werr := conn.Write(ctx, websocket.MessageBinary, forward); werr != nil {
						return
					}
				}
				if detached {
					detachedByUser.Store(true)
					fmt.Fprintf(os.Stderr, "\r\n[detached from %q - it keeps running]\r\n", name)
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	var readErr error
	for {
		msgType, data, rerr := conn.Read(ctx)
		if rerr != nil {
			readErr = rerr
			break
		}
		if msgType == websocket.MessageBinary {
			_, _ = os.Stdout.Write(data)
		}
	}
	switch {
	case detachedByUser.Load():
		// Already announced by the stdin goroutine.
	case websocket.CloseStatus(readErr) == websocket.StatusNormalClosure || errors.Is(readErr, context.Canceled):
		// The session ended (its shell exited - Ctrl+D, `exit`, a kill).
		// It's gone for the browser tab too, which is exactly the outcome
		// someone reaching for Ctrl+D as "how do I get out of attach"
		// doesn't expect.
		fmt.Fprintf(os.Stderr, "\r\n[session %q ended - use %s next time to leave it running]\r\n", name, describeDetachSequence(detachSeq))
	default:
		// Anything else is this client giving up, not the session ending -
		// print it instead of exiting silently. A silent exit 0 here is
		// what made an oversized scrollback replay (see the read-limit
		// comment above) look like "attach just drops me back to my shell".
		fmt.Fprintf(os.Stderr, "\r\n[disconnected from %q: %v]\r\n", name, readErr)
	}
	return 0
}
