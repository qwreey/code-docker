package authgate

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrRateLimited is returned by TryUnlock once a key has failed
// maxFailuresBeforeLockout times in a row — the caller should surface this
// as 429 rather than the ambiguous "incorrect password" 401 a real guess
// gets, so a locked-out client can tell "try again later" from "wrong
// password".
var ErrRateLimited = errors.New("authgate: too many failed attempts")

const (
	maxFailuresBeforeLockout = 5
	lockoutBase              = 5 * time.Second
	lockoutMax               = 5 * time.Minute
)

// attemptState tracks consecutive failures for one key (see TryUnlock's key
// param) since the last success or process start.
type attemptState struct {
	failures    int
	lockedUntil time.Time
}

// CookieName is the HttpOnly cookie set on successful unlock and checked by
// RequirePassword/verify on every gated request.
const CookieName = "webmanager_unlock"

// sessionTTL governs the webmanager write-gate (RequirePassword) — kept
// short deliberately so a "still unlocked" window doesn't linger past a
// realistic single sitting.
const sessionTTL = 10 * time.Minute

// Gate is a stateful password gate: a configured argon2id hash (or none —
// see New) plus an HMAC secret used to sign/verify self-describing unlock
// tokens. There is deliberately no server-side session store — a token
// carries its own issue time (HMAC-signed so it can't be forged), checked
// against sessionTTL in tokenAge.
type Gate struct {
	hash   string
	secret []byte

	attemptsMu sync.Mutex
	attempts   map[string]*attemptState
}

// New creates a Gate. An empty hash means the gate is disabled: Configured
// returns false and RequirePassword passes every request through
// unconditionally. This is the default (no env var set) — see package doc.
//
// The HMAC secret is freshly random on every call, never persisted — a
// process restart therefore invalidates every previously issued token, the
// same "restart re-locks everything" behavior the old in-memory session
// store had.
func New(hash string) *Gate {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// crypto/rand failing at boot means the process can't safely mint
		// unforgeable tokens at all — nothing downstream would work either.
		panic("authgate: failed to generate HMAC secret: " + err.Error())
	}
	return &Gate{hash: hash, secret: secret, attempts: map[string]*attemptState{}}
}

// rateLimited reports whether key is currently locked out, and for how much
// longer.
func (g *Gate) rateLimited(key string) (time.Duration, bool) {
	g.attemptsMu.Lock()
	defer g.attemptsMu.Unlock()
	st := g.attempts[key]
	if st == nil {
		return 0, false
	}
	if remaining := time.Until(st.lockedUntil); remaining > 0 {
		return remaining, true
	}
	return 0, false
}

// recordFailure bumps key's consecutive-failure count and, once it reaches
// maxFailuresBeforeLockout, starts (or extends) an exponential-backoff
// lockout — doubling per failure beyond the threshold, capped at
// lockoutMax, so a sustained guessing campaign gets throttled to a handful
// of attempts per lockoutMax window instead of running at argon2id's raw
// per-attempt cost.
func (g *Gate) recordFailure(key string) {
	g.attemptsMu.Lock()
	defer g.attemptsMu.Unlock()
	st := g.attempts[key]
	if st == nil {
		st = &attemptState{}
		g.attempts[key] = st
	}
	st.failures++
	if st.failures >= maxFailuresBeforeLockout {
		backoff := lockoutBase * time.Duration(1<<uint(st.failures-maxFailuresBeforeLockout))
		if backoff > lockoutMax {
			backoff = lockoutMax
		}
		st.lockedUntil = time.Now().Add(backoff)
	}
}

// recordSuccess clears key's failure history on a correct password.
func (g *Gate) recordSuccess(key string) {
	g.attemptsMu.Lock()
	defer g.attemptsMu.Unlock()
	delete(g.attempts, key)
}

// Configured reports whether a password hash is set, i.e. whether the gate
// is doing anything at all.
func (g *Gate) Configured() bool {
	return g != nil && g.hash != ""
}

// issueToken mints a token of the form "<b64(issued-at)>.<b64(hmac)>" — the
// payload is the plain decimal unix timestamp, signed so it can't be
// tampered with. There's no stored session state; verification is entirely
// self-contained (see tokenAge).
func (g *Gate) issueToken() string {
	payload := strconv.FormatInt(time.Now().Unix(), 10)
	sig := g.sign([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (g *Gate) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, g.secret)
	mac.Write(payload)
	return mac.Sum(nil)
}

// tokenAge extracts and verifies the unlock cookie on r, returning how long
// ago it was issued. ok is false if there's no cookie, it's malformed, the
// signature doesn't match, or it claims to be issued in the future (clock
// skew or tampering — rejected rather than treated as "very fresh").
func (g *Gate) tokenAge(r *http.Request) (time.Duration, bool) {
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return 0, false
	}
	parts := strings.SplitN(cookie.Value, ".", 2)
	if len(parts) != 2 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return 0, false
	}
	givenSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, false
	}
	if !hmac.Equal(givenSig, g.sign(payload)) {
		return 0, false
	}
	issuedUnix, err := strconv.ParseInt(string(payload), 10, 64)
	if err != nil {
		return 0, false
	}
	age := time.Since(time.Unix(issuedUnix, 0))
	if age < 0 {
		return 0, false
	}
	return age, true
}

// Unlocked reports whether the request carries a currently-valid unlock
// token under the webmanager write-gate TTL. Safe to call even when the
// gate isn't configured (always false in that case, since no cookie would
// ever have been issued).
func (g *Gate) Unlocked(r *http.Request) bool {
	if g == nil {
		return false
	}
	age, ok := g.tokenAge(r)
	return ok && age <= sessionTTL
}

// UnlockedUntil is like Unlocked but also returns the unlock's expiry time
// — used by the auth status endpoint so the sidebar can show how long the
// current unlock still has left, not just a locked/unlocked bool.
func (g *Gate) UnlockedUntil(r *http.Request) (time.Time, bool) {
	if g == nil {
		return time.Time{}, false
	}
	age, ok := g.tokenAge(r)
	if !ok || age > sessionTTL {
		return time.Time{}, false
	}
	return time.Now().Add(sessionTTL - age), true
}

// TryUnlock verifies plaintext against the configured hash. key identifies
// the caller for rate-limiting purposes (see recordFailure) — pass a
// client-address-derived string, not anything attacker-controlled, since a
// forgeable key lets an attacker reset their own lockout at will. On
// success it mints a new signed token; the caller is responsible for
// setting it as a cookie via SetCookie. Returns ok=false (no error) for a
// simple wrong password, ok=false with err=ErrRateLimited once key is
// locked out, and ok=false with err set for unexpected failures (e.g. a
// malformed configured hash).
func (g *Gate) TryUnlock(key, plaintext string) (token string, ok bool, err error) {
	if !g.Configured() {
		return "", false, nil
	}
	if remaining, locked := g.rateLimited(key); locked {
		return "", false, fmt.Errorf("%w: try again in %s", ErrRateLimited, remaining.Round(time.Second))
	}
	match, verr := VerifyPassword(plaintext, g.hash)
	if verr != nil {
		return "", false, verr
	}
	if !match {
		g.recordFailure(key)
		return "", false, nil
	}
	g.recordSuccess(key)
	return g.issueToken(), true, nil
}

// SetCookie sets the unlock cookie on w. HttpOnly + SameSite=Strict: it's
// never read from JS and never sent on cross-site requests, only same-site
// navigation/XHR. MaxAge covers sessionTTL so the browser doesn't discard it
// before Unlocked's own check would.
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
