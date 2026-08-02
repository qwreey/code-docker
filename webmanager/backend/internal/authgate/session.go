package authgate

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

// sessionTTL is how long an unlock cookie stays valid after a successful
// password check. Intentionally short: this is a grace window so an operator
// isn't re-prompted for the password on every single gated write, not a
// long-lived login session.
const sessionTTL = 10 * time.Minute

// sessionStore is a tiny in-memory token -> expiry map guarded by a mutex.
// It intentionally doesn't persist across process restarts — a container
// restart re-locks everything, which is fine for this use case (the
// operator unlocks again from the browser).
type sessionStore struct {
	mu     sync.Mutex
	tokens map[string]time.Time
}

func newSessionStore() *sessionStore {
	return &sessionStore{tokens: make(map[string]time.Time)}
}

// issue mints a new random opaque token (32 bytes from crypto/rand,
// base64url-encoded) and stores it with a fresh expiry. Also opportunistically
// sweeps expired tokens so the map doesn't grow unbounded across a long
// container uptime.
func (s *sessionStore) issue() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	expiry := time.Now().Add(sessionTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[token] = expiry
	now := time.Now()
	for t, exp := range s.tokens {
		if now.After(exp) {
			delete(s.tokens, t)
		}
	}
	return token, nil
}

// valid reports whether token is present and not yet expired. An expired
// entry is deleted as a side effect.
func (s *sessionStore) valid(token string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.tokens[token]
	if !ok {
		return false
	}
	if time.Now().After(expiry) {
		delete(s.tokens, token)
		return false
	}
	return true
}
