package tailscale

import (
	"os/exec"
	"sync"
)

// LoginManager runs `tailscale up` as a detached background process on
// demand, so the Tailscale tab can offer a login retry button once
// tailscale-service.default.sh's own automatic first-boot attempt has
// already been used up (see that script's LOGIN_ATTEMPTED_MARKER comment -
// this exists specifically so retries don't have to go through a container
// restart, which is what caused repeated pending logins to pile up on the
// control server in the first place). Ported from
// webmanager/backend/internal/tailscale/login.go, with FindBinary's
// binpath-override plumbing dropped — `tailscale` is resolved on PATH the
// same way state.go's GetState already does, since it's pacman-installed in
// router/Dockerfile.
//
// No stdout scraping or stdin relay is needed: `tailscale status --json`
// (GetStatus) already exposes BackendState/AuthURL structurally, so the
// frontend just re-polls the existing status endpoint after calling Start.
// That makes this manager much thinner - it only needs to track whether a
// process is currently in flight, to avoid starting a second concurrent
// `tailscale up` against the same daemon.
type LoginManager struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
}

// NewLoginManager returns an empty LoginManager, ready to use.
func NewLoginManager() *LoginManager {
	return &LoginManager{}
}

// Start spawns `tailscale up` (optionally with --login-server/--hostname) in
// the background and returns immediately; a goroutine reaps the process when
// it finishes. A no-op, non-error if a previous Start's process is still
// running - the caller should just keep polling status instead of stacking
// a second login attempt onto the same daemon.
func (m *LoginManager) Start(loginServer, hostname string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return nil
	}

	args := []string{"up"}
	if loginServer != "" {
		args = append(args, "--login-server="+loginServer)
	}
	if hostname != "" {
		args = append(args, "--hostname="+hostname)
	}
	cmd := exec.Command("tailscale", args...)
	if err := cmd.Start(); err != nil {
		return err
	}

	m.cmd = cmd
	m.running = true

	go func() {
		_ = cmd.Wait()
		m.mu.Lock()
		if m.cmd == cmd {
			m.running = false
		}
		m.mu.Unlock()
	}()

	return nil
}

// Cancel kills the in-flight `tailscale up` process, if any. Idempotent: a
// no-op when nothing is running, so the frontend can call it best-effort
// without error handling.
func (m *LoginManager) Cancel() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.running || m.cmd == nil || m.cmd.Process == nil {
		return nil
	}
	return m.cmd.Process.Kill()
}
