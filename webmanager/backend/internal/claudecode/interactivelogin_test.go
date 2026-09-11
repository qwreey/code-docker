package claudecode

import (
	"testing"
	"time"

	"webmanager/internal/termsession"
)

// newTestInteractiveSession installs a PTY running command as m's current
// session under id. Start itself isn't used because it runs the command in
// /code, which only exists inside the container; Cwd points it somewhere
// that exists everywhere instead.
func newTestInteractiveSession(t *testing.T, m *InteractiveLoginManager, id, command string) *termsession.Session {
	t.Helper()
	s, err := termsession.NewStandalone(interactiveLoginSessionName, command, nil, interactiveLoginScrollbackBytes, termsession.CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("starting %s: %v", command, err)
	}
	t.Cleanup(s.Close)
	m.mu.Lock()
	m.current = s
	m.id = id
	m.mu.Unlock()
	return s
}

func TestInteractiveLoginSessionAlive(t *testing.T) {
	m := NewInteractiveLoginManager()
	newTestInteractiveSession(t, m, "live", "/bin/cat")

	if _, ok := m.Session("live"); !ok {
		t.Fatal("running session reported gone")
	}
	if _, ok := m.Session("other"); ok {
		t.Fatal("unknown id reported alive")
	}

	if err := m.Cancel("live"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, ok := m.Session("live"); ok {
		t.Fatal("cancelled session reported alive")
	}
}

// A CLI that exits on its own leaves m.current pointing at a dead session;
// it must still read as gone, or the frontend would keep reconnecting to a
// session with nothing behind it.
func TestInteractiveLoginSessionExitedIsGone(t *testing.T) {
	m := NewInteractiveLoginManager()
	s := newTestInteractiveSession(t, m, "exits", "/bin/true")

	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("session did not notice its process exiting")
	}
	if _, ok := m.Session("exits"); ok {
		t.Fatal("exited session reported alive")
	}
}
