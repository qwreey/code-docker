package claudecode

import (
	"sync"
	"time"

	"webmanager/internal/termsession"
)

// interactiveLoginScrollbackBytes bounds the ring buffer for the login
// wizard's own PTY output - its screens are small and short-lived, nowhere
// near a real terminal session's needs, but termsession.NewStandalone still
// needs a value.
const interactiveLoginScrollbackBytes = 64 * 1024

// interactiveLoginSessionName is a fixed, purely cosmetic label (only used
// in termsession's own logging) - this Session is never inserted into any
// termsession.Registry, so nothing ever looks it up by name the way a real
// terminal tab would.
const interactiveLoginSessionName = "claude-interactive-login"

// InteractiveLoginTimeout bounds how long the underlying `claude` PTY
// process is allowed to run unattended, mirroring loginSessionTimeout in
// login.go for the same reason (a closed browser tab must not leak the
// process forever). termsession.Session has no timeout of its own, so this
// manager enforces it with a plain timer.
const InteractiveLoginTimeout = 10 * time.Minute

// InteractiveLoginManager runs the real `claude` CLI as an interactive PTY
// session (see termsession.NewStandalone) so webmanager can embed its
// actual first-run onboarding wizard (theme + login-method chooser) in a
// dialog instead of driving `claude auth login` headlessly - the two are
// not equivalent: the interactive wizard is what marks onboarding complete
// for every future bare `claude` launch (e.g. in code-server's integrated
// terminal), which `claude auth login` alone never does, even though it
// does populate valid credentials `claude auth status` recognizes
// immediately. See root CLAUDE.md's webmanager section for the incident
// this was built to fix. Only one session is ever tracked at a time, same
// "fresh Start supersedes whatever was running" policy as LoginManager.
type InteractiveLoginManager struct {
	mu      sync.Mutex
	current *termsession.Session
	id      string
	timer   *time.Timer
}

// NewInteractiveLoginManager returns an empty InteractiveLoginManager,
// ready to use.
func NewInteractiveLoginManager() *InteractiveLoginManager {
	return &InteractiveLoginManager{}
}

// Start kills any still-running previous interactive login session, then
// starts `claude` (binPath) directly as a new PTY's leader process - not
// wrapped in a shell, so the process exiting (the user completing the
// wizard and this manager sending it two Ctrl+C, or the CLI exiting on its
// own) is a plain PTY EOF the caller can observe via the returned Session's
// Done(). Returns immediately; the frontend attaches to it over the
// WebSocket endpoint that looks the returned id up via Session below.
func (m *InteractiveLoginManager) Start(binPath string) (id string, sess *termsession.Session, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current != nil {
		m.current.Close()
		if m.timer != nil {
			m.timer.Stop()
		}
	}

	s, err := termsession.NewStandalone(interactiveLoginSessionName, binPath, nil, interactiveLoginScrollbackBytes, termsession.CreateOptions{})
	if err != nil {
		return "", nil, err
	}

	newID := newLoginID()
	m.current = s
	m.id = newID
	m.timer = time.AfterFunc(InteractiveLoginTimeout, func() {
		_ = m.Cancel(newID)
	})

	return newID, s, nil
}

// Session returns the current session if id still names it (not superseded
// by a newer Start, or already cancelled/expired) - ok is false otherwise,
// same "session gone, start over" contract as LoginManager.Status.
func (m *InteractiveLoginManager) Session(id string) (sess *termsession.Session, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.id != id {
		return nil, false
	}
	return m.current, true
}

// Cancel closes session id's PTY (SIGHUP, then SIGKILL after termsession's
// own grace period) if it's still the current session. Idempotent/
// best-effort, matching LoginManager.Cancel's contract - the frontend calls
// this both as a fallback after sending the wizard two Ctrl+C (belt and
// suspenders, in case the CLI didn't actually exit) and on dialog-close/
// unmount, and shouldn't get an alarming error either way.
func (m *InteractiveLoginManager) Cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.id != id {
		return nil
	}
	m.current.Close()
	if m.timer != nil {
		m.timer.Stop()
	}
	m.current = nil
	m.id = ""
	return nil
}
