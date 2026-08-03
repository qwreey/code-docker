package claudecode

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sync"
	"time"
)

// urlRe extracts the first URL from a line of `claude auth login` output.
// A bare https:// match (rather than the literal "If the browser didn't
// open, visit:" prefix, empirically observed on claude 2.1.220) is
// deliberately robust against that wording changing between CLI versions —
// see webmanager/.claude/claude-plan.md's login research notes.
var urlRe = regexp.MustCompile(`https://\S+`)

// loginSessionTimeout bounds how long a single `claude auth login` process
// is allowed to stay alive unattended. A human needs real time to open a
// browser, sign in, and paste the resulting code back, but an abandoned
// session (browser tab closed, never finished) must not leak the process
// forever.
const loginSessionTimeout = 10 * time.Minute

// loginProc is one running (or just-finished) `claude auth login` session.
// Fields below the mutex are guarded by it. A per-session lock is used here
// (rather than mise.JobStore's single store-wide lock) because LoginManager
// separately needs its own lock to guard `current`/id-matching independent
// of whatever this session's own goroutines are doing to its state.
type loginProc struct {
	mu       sync.Mutex
	id       string
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	lines    []string
	url      string // first urlRe match found in output; "" until then
	running  bool
	exitCode *int
	// cancel cancels the loginSessionTimeout context this process runs
	// under (which also triggers exec.CommandContext's own kill-on-cancel
	// behavior), doubling as this session's manual kill switch for
	// LoginManager.Cancel and for a superseding Start.
	cancel context.CancelFunc
}

func (p *loginProc) appendLine(line string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lines = append(p.lines, line)
	if p.url == "" {
		if m := urlRe.FindString(line); m != "" {
			p.url = m
		}
	}
}

func (p *loginProc) setDone(code int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = false
	p.exitCode = &code
}

func (p *loginProc) snapshot() (lines []string, url string, running bool, exitCode *int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	lines = make([]string, len(p.lines))
	copy(lines, p.lines)
	return lines, p.url, p.running, p.exitCode
}

func (p *loginProc) isRunning() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running
}

// kill cancels p's context (which makes exec.CommandContext kill the
// process) and, belt-and-suspenders, also kills the process directly in
// case it hasn't been started far enough for the context plumbing to have
// taken effect yet.
func (p *loginProc) kill() {
	if p.cancel != nil {
		p.cancel()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

// LoginManager runs `claude auth login` as a managed background process so
// webmanager can proxy the CLI's interactive paste-a-code OAuth flow over
// HTTP (see claude-plan.md's "로그인(OAuth) 연계" section) — a browser opens
// the URL the CLI prints, the user signs in, and pastes the resulting code
// back through SubmitCode. Only one session is ever tracked at a time: a
// fresh Start supersedes (kills) whatever was running before rather than
// running alongside it. Unlike mise.JobStore, there's no TTL-based pruning
// of finished sessions — a single `current` slot is enough since there's
// only ever one login flow, not many concurrent jobs.
type LoginManager struct {
	mu      sync.Mutex
	current *loginProc
}

// NewLoginManager returns an empty LoginManager, ready to use.
func NewLoginManager() *LoginManager {
	return &LoginManager{}
}

func newLoginID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Start kills any still-running previous session, then spawns a new
// `claude auth login` process and returns its session id immediately; the
// process and its output-scanning goroutines keep running in the
// background after Start returns. Deliberately run under
// context.Background() (wrapped in its own loginSessionTimeout), not the
// starting HTTP request's context — the user needs time well past that
// request's lifetime to go open a browser, sign in, and copy a code back.
func (m *LoginManager) Start(binPath string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current != nil && m.current.isRunning() {
		m.current.kill()
	}

	ctx, cancel := context.WithTimeout(context.Background(), loginSessionTimeout)
	cmd := exec.CommandContext(ctx, binPath, "auth", "login")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return "", err
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return "", err
	}

	proc := &loginProc{
		id:      newLoginID(),
		cmd:     cmd,
		stdin:   stdin,
		running: true,
		cancel:  cancel,
		lines:   []string{},
	}
	m.current = proc

	scan := func(r io.Reader) {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for scanner.Scan() {
			proc.appendLine(scanner.Text())
		}
	}
	go scan(stdout)
	go scan(stderr)

	go func() {
		waitErr := cmd.Wait()
		cancel()

		code := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		proc.setDone(code)
	}()

	return proc.id, nil
}

// Status returns a snapshot of session id's current state. ok is false if
// id doesn't match the current session (superseded by a newer Start, or
// never existed) — the frontend should treat that as "session gone, start
// over," not retry forever.
func (m *LoginManager) Status(id string) (lines []string, url string, running bool, exitCode *int, ok bool) {
	m.mu.Lock()
	proc := m.current
	m.mu.Unlock()

	if proc == nil || proc.id != id {
		return nil, "", false, nil, false
	}

	lines, url, running, exitCode = proc.snapshot()
	return lines, url, running, exitCode, true
}

// SubmitCode relays a user-pasted OAuth code back to session id's stdin.
// Returns a plain error (never panics) if id doesn't match the current
// session or the process has already exited / its stdin is closed.
func (m *LoginManager) SubmitCode(id, code string) error {
	m.mu.Lock()
	proc := m.current
	m.mu.Unlock()

	if proc == nil || proc.id != id {
		return fmt.Errorf("no such login session: %s", id)
	}
	if !proc.isRunning() {
		return fmt.Errorf("login session %s already exited", id)
	}
	if _, err := io.WriteString(proc.stdin, code+"\n"); err != nil {
		return fmt.Errorf("write code to login session: %w", err)
	}
	return nil
}

// Cancel kills session id's process if it's still the current session.
// Idempotent: a no-op, non-error if id doesn't match the current session
// (already superseded or finished) — the frontend calls this best-effort
// on unmount and shouldn't get an alarming error for something already
// cleaned up.
func (m *LoginManager) Cancel(id string) error {
	m.mu.Lock()
	proc := m.current
	m.mu.Unlock()

	if proc == nil || proc.id != id {
		return nil
	}
	proc.kill()
	return nil
}
