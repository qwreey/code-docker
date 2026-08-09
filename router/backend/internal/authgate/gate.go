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

// Errors returned by SetupPassword/ChangePassword (see store.go) - handlers
// map these to specific HTTP status codes.
var (
	ErrAlreadyConfigured = errors.New("authgate: password already configured")
	ErrNotConfigured     = errors.New("authgate: no password configured yet")
	ErrEnvPinned         = errors.New("authgate: password is pinned by ROUTER_MANAGER_AUTH_PASSWORD_HASH, not changeable via API")
	ErrWrongPassword     = errors.New("authgate: incorrect current password")
	// ErrRateLimited is returned by TryUnlock once a key has failed
	// maxFailuresBeforeLockout times in a row - handlers surface this as
	// 429 rather than the ambiguous "incorrect password" 401 a real guess
	// gets.
	ErrRateLimited = errors.New("authgate: too many failed attempts")
)

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
// RequirePassword on every gated request.
const CookieName = "router_manager_unlock"

// sessionTTL governs how long an unlock lasts. Router-manager's gated
// routes are infrequent admin actions (tailscale login, forwards/publish
// edits, dev-proxy expose edits), not a page someone sits in continuously,
// so this is deliberately on the shorter side — same order of magnitude as
// webmanager's own write-gate TTL.
const sessionTTL = 15 * time.Minute

// Gate is a stateful password gate: an effective argon2id hash (or none —
// see New) plus an HMAC secret used to sign/verify self-describing unlock
// tokens. There is deliberately no server-side session store — a token
// carries its own issue time, HMAC-signed so it can't be forged.
//
// The effective hash comes from one of two sources (see currentHash):
// envHash (ROUTER_MANAGER_AUTH_PASSWORD_HASH) always wins when set — an
// infra-as-code pin for operators who want it fixed at container-start,
// immune to any in-app change. Otherwise storePath (a JSON file on
// router's own volume, see store.go) is read — this is what
// SetupPassword/ChangePassword write to. Unlike webmanager's own gate
// (env-var-only, specifically because code-docker itself is the untrusted
// party and could restart its own process to bypass a writable config
// file), a router-manager-owned file is safe to be authoritative: the only
// way to reach the API that writes it is already through this same gate
// (SetupPassword only works when nothing is configured yet, ChangePassword
// requires the current password) — code-docker has no filesystem or
// process-restart access to router's own container at all.
//
// Always a host-only cookie (no configurable Domain) — unlike webmanager's
// own gate, router-manager's endpoints are only ever reached through
// router's own nginx on that same origin, never a separate wildcard
// subdomain, so there's no cross-origin-sharing case to support.
type Gate struct {
	envHash   string
	storePath string
	secret    []byte

	attemptsMu sync.Mutex
	attempts   map[string]*attemptState
}

// New creates a Gate. envHash empty means no infra-as-code pin; storePath
// empty disables file-backed setup/change entirely (Configured() then
// depends solely on envHash, and SetupPassword/ChangePassword always
// error). Gate is disabled (Configured() false, RequirePassword passes
// every request through) only when neither source yields a hash — the
// default when nothing has been set up yet.
//
// The HMAC secret is freshly random on every call, never persisted — a
// process restart therefore invalidates every previously issued token.
func New(envHash, storePath string) *Gate {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// crypto/rand failing at boot means the process can't safely mint
		// unforgeable tokens at all — nothing downstream would work either.
		panic("authgate: failed to generate HMAC secret: " + err.Error())
	}
	return &Gate{envHash: envHash, storePath: storePath, secret: secret, attempts: map[string]*attemptState{}}
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
// lockout - doubling per failure beyond the threshold, capped at
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

// currentHash resolves the effective hash: envHash if set, else whatever's
// currently persisted at storePath (best-effort read — any error, including
// "file doesn't exist yet", resolves to "", the same as "not configured").
func (g *Gate) currentHash() string {
	if g.envHash != "" {
		return g.envHash
	}
	if g.storePath == "" {
		return ""
	}
	hash, _ := readStoredHash(g.storePath)
	return hash
}

// Configured reports whether an effective password hash is set, i.e.
// whether the gate is doing anything at all.
func (g *Gate) Configured() bool {
	return g != nil && g.currentHash() != ""
}

// Source reports where the effective hash comes from - lets the frontend
// distinguish a first-time setup screen ("unset") from a change-password
// screen ("file"), and know when the change endpoint will refuse because
// the env var pins it ("env").
func (g *Gate) Source() string {
	if g == nil {
		return "unset"
	}
	if g.envHash != "" {
		return "env"
	}
	if g.currentHash() != "" {
		return "file"
	}
	return "unset"
}

// SetupPassword sets the initial password, file-backed — only allowed when
// nothing is configured yet (neither envHash nor a prior stored hash).
// Deliberately not itself gated by RequirePassword (see handlers_auth.go):
// there's nothing to authenticate against until this succeeds once.
func (g *Gate) SetupPassword(plaintext string) error {
	if g.storePath == "" {
		return errors.New("authgate: no store path configured")
	}
	if g.Configured() {
		return ErrAlreadyConfigured
	}
	hash, err := HashPassword(plaintext)
	if err != nil {
		return err
	}
	return writeStoredHash(g.storePath, hash)
}

// ChangePassword replaces the stored password, requiring the current one.
// Refuses if envHash pins the effective hash (an API-driven change would be
// silently shadowed by the env var on every request anyway, so refuse
// rather than pretend it worked) or if nothing is configured yet (use
// SetupPassword instead).
func (g *Gate) ChangePassword(currentPlaintext, newPlaintext string) error {
	if g.envHash != "" {
		return ErrEnvPinned
	}
	current := g.currentHash()
	if current == "" {
		return ErrNotConfigured
	}
	match, err := VerifyPassword(currentPlaintext, current)
	if err != nil {
		return err
	}
	if !match {
		return ErrWrongPassword
	}
	hash, err := HashPassword(newPlaintext)
	if err != nil {
		return err
	}
	return writeStoredHash(g.storePath, hash)
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
// token. Safe to call even when the gate isn't configured (always false in
// that case, since no cookie would ever have been issued).
func (g *Gate) Unlocked(r *http.Request) bool {
	if g == nil {
		return false
	}
	age, ok := g.tokenAge(r)
	return ok && age <= sessionTTL
}

// UnlockedUntil is like Unlocked but also returns the unlock's expiry time
// — used by the status endpoint so the frontend can show remaining time
// instead of just a locked/unlocked bool.
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
// the caller for rate-limiting purposes (see recordFailure) - pass a
// client-address-derived string, not anything attacker-controlled, since a
// forgeable key lets an attacker reset their own lockout at will. On
// success it mints a new signed token; the caller is responsible for
// setting it as a cookie via SetCookie. Returns ok=false (no error) for a
// simple wrong password, ok=false with err=ErrRateLimited once key is
// locked out, and ok=false with err set for unexpected failures (e.g. a
// malformed configured hash).
func (g *Gate) TryUnlock(key, plaintext string) (token string, ok bool, err error) {
	hash := g.currentHash()
	if hash == "" {
		return "", false, nil
	}
	if remaining, locked := g.rateLimited(key); locked {
		return "", false, fmt.Errorf("%w: try again in %s", ErrRateLimited, remaining.Round(time.Second))
	}
	match, verr := VerifyPassword(plaintext, hash)
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

// SetCookie sets the unlock cookie on w. HttpOnly + SameSite=Strict: never
// read from JS, never sent on cross-site requests.
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
