package authgate

import "net/http"

// CookieName is the HttpOnly cookie set on successful unlock and checked by
// RequirePassword on every gated request.
const CookieName = "webmanager_unlock"

// Gate is a stateful password gate: a configured argon2id hash (or none —
// see New) plus an in-memory session store of currently-unlocked tokens.
type Gate struct {
	hash     string
	sessions *sessionStore
}

// New creates a Gate. An empty hash means the gate is disabled: Configured
// returns false and RequirePassword passes every request through
// unconditionally. This is the default (no env var set) — see package doc.
func New(hash string) *Gate {
	return &Gate{hash: hash, sessions: newSessionStore()}
}

// Configured reports whether a password hash is set, i.e. whether the gate
// is doing anything at all.
func (g *Gate) Configured() bool {
	return g != nil && g.hash != ""
}

// Unlocked reports whether the request carries a currently-valid unlock
// cookie. Safe to call even when the gate isn't configured (always false in
// that case, since no cookie would ever have been issued).
func (g *Gate) Unlocked(r *http.Request) bool {
	if g == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return false
	}
	return g.sessions.valid(cookie.Value)
}

// TryUnlock verifies plaintext against the configured hash. On success it
// issues a new session token; the caller is responsible for setting it as a
// cookie via SetCookie. Returns ok=false (no error) for a simple wrong
// password, and ok=false with err set only for unexpected failures (e.g. a
// malformed configured hash, or entropy source failure minting the token).
func (g *Gate) TryUnlock(plaintext string) (token string, ok bool, err error) {
	if !g.Configured() {
		return "", false, nil
	}
	match, verr := VerifyPassword(plaintext, g.hash)
	if verr != nil {
		return "", false, verr
	}
	if !match {
		return "", false, nil
	}
	token, err = g.sessions.issue()
	if err != nil {
		return "", false, err
	}
	return token, true, nil
}

// SetCookie sets the unlock cookie on w. HttpOnly + SameSite=Strict: it's
// never read from JS and never sent on cross-site requests, only same-site
// navigation/XHR to webmanager itself.
func (g *Gate) SetCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// RequirePassword gates next behind the configured password. If the gate
// isn't configured at all, requests pass through unconditionally — this is
// the critical "off by default" behavior: no currently-working
// unauthenticated route should break just because this middleware now
// exists somewhere in front of it.
func (g *Gate) RequirePassword(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.Configured() {
			next.ServeHTTP(w, r)
			return
		}
		if !g.Unlocked(r) {
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"password required"}`))
}
