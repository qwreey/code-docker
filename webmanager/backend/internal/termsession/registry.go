package termsession

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"
)

// Registry owns every live named Session, keyed by name. All exported
// methods are safe for concurrent use.
type Registry struct {
	// shellFunc is called fresh for every new session (not resolved once at
	// construction) so it stays behaviorally identical to M1's per-connection
	// rootLoginShell() call — e.g. it keeps reflecting /etc/passwd if that
	// ever changes at runtime.
	shellFunc       func() string
	scrollbackBytes int
	idleTimeout     time.Duration
	gcInterval      time.Duration

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewRegistry(shellFunc func() string, scrollbackBytes int, idleTimeout time.Duration) *Registry {
	return &Registry{
		shellFunc:       shellFunc,
		scrollbackBytes: scrollbackBytes,
		idleTimeout:     idleTimeout,
		gcInterval:      time.Minute,
		sessions:        make(map[string]*Session),
	}
}

// GetOrCreate returns the named session, creating (and starting) a new PTY
// for it if this name hasn't been seen before. opts is only consulted on
// that creation path — reattaching to an existing session ignores it.
func (r *Registry) GetOrCreate(name string, opts CreateOptions) (*Session, error) {
	if err := ValidateName(name); err != nil {
		return nil, err
	}

	r.mu.Lock()
	if s, ok := r.sessions[name]; ok {
		r.mu.Unlock()
		return s, nil
	}
	r.mu.Unlock()

	s, err := newSession(name, r.shellFunc(), r.scrollbackBytes, opts)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	// Re-check: two requests for the same never-before-seen name could have
	// raced past the first lock section above and both started spawning a
	// PTY. Keep whichever won the map-insert race, discard the loser's.
	if existing, ok := r.sessions[name]; ok {
		r.mu.Unlock()
		s.Close()
		return existing, nil
	}
	r.sessions[name] = s
	r.mu.Unlock()
	go r.forgetWhenDone(s)
	return s, nil
}

// forgetWhenDone removes s from the registry once it finishes on its own
// (pump() noticing PTY EOF — e.g. Ctrl+D exiting the shell — is the case
// Remove/reapIdle don't already handle themselves, since those two delete
// from the map before calling Close()). It reads s.currentName() rather than
// closing over the name s was created with, since Rename can re-key it in
// the meantime - using a stale captured name here would look up the wrong
// (already-deleted) map entry and leak the session's current entry forever.
// The pointer-equality check guards against a race where that current name
// was already removed and a new session with the same name created in the
// meantime — this goroutine must never delete that newer session's map entry
// out from under it.
func (r *Registry) forgetWhenDone(s *Session) {
	<-s.Done()
	r.mu.Lock()
	name := s.currentName()
	if r.sessions[name] == s {
		delete(r.sessions, name)
	}
	r.mu.Unlock()
}

// Rename atomically re-keys a session from oldName to newName in place - the
// same *Session (live PTY, goroutines, attached WebSocket sink if any) just
// addressable under a new name afterward, never destroyed/recreated.
// Renaming to the name it already has is a no-op success. Returns
// ErrSessionGone if oldName doesn't exist, ErrNameTaken if newName already
// names a different live session.
func (r *Registry) Rename(oldName, newName string) error {
	if err := ValidateName(newName); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	s, ok := r.sessions[oldName]
	if !ok {
		return ErrSessionGone
	}
	if newName == oldName {
		return nil
	}
	if _, taken := r.sessions[newName]; taken {
		return ErrNameTaken
	}

	delete(r.sessions, oldName)
	r.sessions[newName] = s
	s.rename(newName)
	return nil
}

func (r *Registry) List() []Info {
	r.mu.Lock()
	sessions := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()

	out := make([]Info, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s.info())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (r *Registry) SetPinned(name string, pinned bool) error {
	r.mu.Lock()
	s, ok := r.sessions[name]
	r.mu.Unlock()
	if !ok {
		return ErrSessionGone
	}
	s.SetPinned(pinned)
	return nil
}

// Remove kills and forgets the named session (an explicit "close this tab
// for good" action, distinct from a client merely disconnecting).
func (r *Registry) Remove(name string) error {
	r.mu.Lock()
	s, ok := r.sessions[name]
	if ok {
		delete(r.sessions, name)
	}
	r.mu.Unlock()
	if !ok {
		return ErrSessionGone
	}
	s.Close()
	return nil
}

// Run periodically reaps unpinned sessions that have had no attached client
// for longer than idleTimeout, until ctx is cancelled. Pinned sessions are
// never reaped by this loop — see terminal-plan.md's "영속 세션 토글" design
// note: pinning is exactly this exemption, nothing more.
func (r *Registry) Run(ctx context.Context) {
	ticker := time.NewTicker(r.gcInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.reapIdle()
		}
	}
}

func (r *Registry) reapIdle() {
	now := time.Now()
	r.mu.Lock()
	var toReap []*Session
	for name, s := range r.sessions {
		pinned, idle, attached := s.reapCheck(now)
		if pinned || attached {
			continue
		}
		if idle >= r.idleTimeout {
			toReap = append(toReap, s)
			delete(r.sessions, name)
		}
	}
	r.mu.Unlock()

	for _, s := range toReap {
		log.Printf("termsession: reaping idle session %q (idle >= %s)", s.currentName(), r.idleTimeout)
		s.Close()
	}
}
