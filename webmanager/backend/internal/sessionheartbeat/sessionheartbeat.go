// Package sessionheartbeat tracks browser tabs currently open against this
// code-server instance, purely for operator visibility (not a security
// feature — see webmanager/.claude/qa-request/session-heartbeat-plan-done.md).
// A code-patch script running inside every code-server tab (config/code-patch/
// session-heartbeat.default.js) POSTs a self-generated id + open folder +
// User-Agent every 30s; this package is just the upsert-and-list store behind
// that, plus a periodic GC so tabs closed without a clean signal (there isn't
// one — this is fire-and-forget heartbeats, not WebSocket) eventually fall out
// of memory.
package sessionheartbeat

import (
	"context"
	"sort"
	"sync"
	"time"
)

// listWindow is how recent a heartbeat must be for List to still surface it —
// distinct from gcIdleAfter below, which is the much longer-lived "delete
// from memory entirely" threshold. Set to the midpoint of the "1~10분" range
// the feature was scoped with; not exposed via env, this is a tuning value
// cheap to bump later if real usage wants it different.
const listWindow = 5 * time.Minute

// gcIdleAfter/gcInterval bound the store's memory: an entry with no
// heartbeat for this long is removed outright (not just filtered out of
// List), and the sweep runs on this interval. Uses the upper end of the
// "10~30분" range the feature was scoped with.
const (
	gcIdleAfter = 30 * time.Minute
	gcInterval  = 15 * time.Minute
)

// Entry is one client-reported tab, keyed by its self-generated id in Store.
type Entry struct {
	ID        string    `json:"id"`
	Folder    string    `json:"folder"`
	UserAgent string    `json:"userAgent"`
	LastSeen  time.Time `json:"lastSeen"`
}

// Store is a tiny in-memory id -> Entry map guarded by a mutex, mirroring
// internal/authgate's sessionStore shape. Doesn't persist across restarts —
// a container restart just means every open tab re-announces itself on its
// next 30s heartbeat, which is fine for a visibility-only feature.
type Store struct {
	mu      sync.Mutex
	entries map[string]Entry
}

func NewStore() *Store {
	return &Store{entries: make(map[string]Entry)}
}

// Heartbeat upserts the entry for id with the given folder/userAgent and the
// current time as LastSeen.
func (s *Store) Heartbeat(id, folder, userAgent string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[id] = Entry{
		ID:        id,
		Folder:    folder,
		UserAgent: userAgent,
		LastSeen:  time.Now(),
	}
}

// List returns every entry heartbeat-ed within listWindow, most-recent
// first.
func (s *Store) List() []Entry {
	cutoff := time.Now().Add(-listWindow)

	s.mu.Lock()
	out := make([]Entry, 0, len(s.entries))
	for _, e := range s.entries {
		if e.LastSeen.After(cutoff) {
			out = append(out, e)
		}
	}
	s.mu.Unlock()

	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// Run periodically deletes entries idle past gcIdleAfter, until ctx is
// cancelled — same ticker-loop shape as termsession.Registry.Run.
func (s *Store) Run(ctx context.Context) {
	ticker := time.NewTicker(gcInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reapIdle()
		}
	}
}

func (s *Store) reapIdle() {
	cutoff := time.Now().Add(-gcIdleAfter)
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, e := range s.entries {
		if e.LastSeen.Before(cutoff) {
			delete(s.entries, id)
		}
	}
}
