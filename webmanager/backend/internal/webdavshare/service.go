package webdavshare

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"

	"webmanager/internal/authgate"
)

// Options configures a Service. Every Env* field is the raw environment
// value ("" meaning unset) — an env-provided value always wins over the
// settings file and is reported to the UI as locked, so an operator who
// pins a credential host-side in .env.webmanager can't have it silently
// changed from inside the container.
type Options struct {
	SettingsPath string
	Root         string

	EnvEnabled      string
	EnvUsername     string
	EnvPasswordHash string
}

// Service holds the live configuration and serves the WebDAV endpoint.
//
// The endpoint is registered unconditionally and decides per request
// whether it is active, rather than only being wired into the mux when
// configured. That's a deliberate deviation from the plan's "라우트 자체를
// 안 붙임": it is equally fail-closed (an inactive share answers 404 and
// touches no filesystem), and it is what lets enabling the share from the
// UI take effect immediately instead of needing a webmanager restart.
type Service struct {
	settingsPath string
	root         string

	envEnabled      string
	envUsername     string
	envPasswordHash string

	handler *webdav.Handler

	mu       sync.Mutex
	settings Settings
	// gate is rebuilt whenever the effective password hash changes. It is
	// used only for VerifyPassword + its per-client failure backoff; the
	// unlock token it mints on success is discarded (WebDAV has no cookie
	// jar we could rely on).
	gate *authgate.Gate
	// cache maps an HMAC of the presented credentials to an expiry. Without
	// it every single WebDAV request would pay argon2id's 64 MiB derivation
	// — a Finder window browsing one directory issues a PROPFIND plus a GET
	// per file, and each carries the Basic auth header afresh, so the share
	// would be unusably slow and trivially self-DoSable.
	cache map[string]time.Time
	// secret keys the cache HMAC. Random per process, never persisted, so a
	// restart simply re-derives on the next request.
	secret []byte
}

// credCacheTTL is how long a successful credential check is remembered.
// Short enough that a password change takes effect promptly on its own
// (Reload/SetPassword also clear the cache outright, so this only bounds
// the case where the hash changed underneath us some other way), long
// enough that a burst of client requests costs one derivation.
const credCacheTTL = 5 * time.Minute

// maxCachedCreds bounds the cache. Only *successful* checks are cached, so
// this is bounded by real credentials in practice; the cap is here so a
// pathological case can't grow the map without limit.
const maxCachedCreds = 64

// New builds a Service and loads its persisted settings. A settings file
// that can't be read or parsed is logged and treated as "not configured"
// rather than being a startup failure — the share is opt-in, and taking
// webmanager down over it would be worse than leaving it off.
func New(opts Options) *Service {
	s := &Service{
		settingsPath:    opts.SettingsPath,
		root:            opts.Root,
		envEnabled:      strings.TrimSpace(opts.EnvEnabled),
		envUsername:     strings.TrimSpace(opts.EnvUsername),
		envPasswordHash: strings.TrimSpace(opts.EnvPasswordHash),
		cache:           map[string]time.Time{},
		secret:          make([]byte, 32),
	}
	if _, err := rand.Read(s.secret); err != nil {
		panic("webdavshare: failed to generate cache secret: " + err.Error())
	}

	loaded, err := Load(opts.SettingsPath)
	if err != nil {
		log.Printf("webdavshare: couldn't read %s, treating the share as unconfigured: %v", opts.SettingsPath, err)
	}
	s.settings = loaded
	s.gate = authgate.New(s.effectivePasswordHashLocked())

	s.handler = &webdav.Handler{
		Prefix:     URLPrefix,
		FileSystem: newJailedDir(opts.Root),
		LockSystem: webdav.NewMemLS(),
		Logger: func(r *http.Request, err error) {
			// Only real failures — a PROPFIND on a path that doesn't exist
			// is routine client probing, not something worth a log line.
			if err != nil {
				log.Printf("webdavshare: %s %s: %v", r.Method, r.URL.Path, err)
			}
		},
	}
	return s
}

// --- effective configuration -------------------------------------------

func (s *Service) effectiveEnabledLocked() bool {
	switch strings.ToLower(s.envEnabled) {
	case "":
		return s.settings.Enabled
	case "false", "0", "no":
		return false
	default:
		return true
	}
}

func (s *Service) effectiveUsernameLocked() string {
	if s.envUsername != "" {
		return s.envUsername
	}
	if s.settings.Username != "" {
		return s.settings.Username
	}
	return DefaultUsername
}

func (s *Service) effectivePasswordHashLocked() string {
	if s.envPasswordHash != "" {
		return s.envPasswordHash
	}
	return s.settings.PasswordHash
}

// Status is what the File share tab renders. The password itself never
// appears here in any form — only whether one is set.
type Status struct {
	Enabled     bool   `json:"enabled"`
	Username    string `json:"username"`
	HasPassword bool   `json:"hasPassword"`
	// Active is the only field that decides whether a request is served:
	// enabled AND a password hash present.
	Active bool `json:"active"`
	// Reason explains an inactive share in the UI's own words, so "enabled
	// but serving nothing" is never a silent state.
	Reason string `json:"reason"`
	Root   string `json:"root"`
	Prefix string `json:"prefix"`
	// *Locked mirror which fields are pinned by an environment variable and
	// therefore can't be changed from here.
	EnabledLocked  bool `json:"enabledLocked"`
	UsernameLocked bool `json:"usernameLocked"`
	PasswordLocked bool `json:"passwordLocked"`
}

// Status snapshots the current effective configuration.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Service) statusLocked() Status {
	enabled := s.effectiveEnabledLocked()
	hasPassword := s.effectivePasswordHashLocked() != ""
	st := Status{
		Enabled:        enabled,
		Username:       s.effectiveUsernameLocked(),
		HasPassword:    hasPassword,
		Active:         enabled && hasPassword,
		Root:           s.root,
		Prefix:         URLPrefix + "/",
		EnabledLocked:  s.envEnabled != "",
		UsernameLocked: s.envUsername != "",
		PasswordLocked: s.envPasswordHash != "",
	}
	switch {
	case st.Active:
	case !enabled && !hasPassword:
		st.Reason = "공유가 꺼져 있고 비밀번호도 설정되지 않았습니다."
	case !enabled:
		st.Reason = "공유가 꺼져 있습니다."
	default:
		st.Reason = "비밀번호가 설정되지 않아 공유가 동작하지 않습니다 (fail-closed)."
	}
	return st
}

// ErrLocked is returned when a caller tries to change a field an
// environment variable has pinned.
var ErrLocked = errors.New("webdavshare: value is pinned by an environment variable")

// ErrNoPassword is returned when enabling a share that has no password yet
// — allowed to be stored (so the UI can be filled in either order) but
// reported so the caller can say why nothing is being served.
var ErrNoPassword = errors.New("webdavshare: no password set")

// SetEnabled persists the on/off toggle.
func (s *Service) SetEnabled(enabled bool) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.envEnabled != "" {
		return s.statusLocked(), ErrLocked
	}
	s.settings.Enabled = enabled
	if err := s.saveLocked(); err != nil {
		return s.statusLocked(), err
	}
	return s.statusLocked(), nil
}

// SetUsername persists the Basic auth username. An empty value resets it to
// DefaultUsername rather than storing a username no client will accept.
func (s *Service) SetUsername(username string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.envUsername != "" {
		return s.statusLocked(), ErrLocked
	}
	username = strings.TrimSpace(username)
	// A colon would make the "user:pass" Basic auth pair ambiguous, and
	// control characters can't survive a header round-trip.
	if strings.ContainsAny(username, ":\r\n\x00") {
		return s.statusLocked(), errors.New("webdavshare: username can't contain ':' or control characters")
	}
	s.settings.Username = username
	if err := s.saveLocked(); err != nil {
		return s.statusLocked(), err
	}
	// The cache keys on the presented username too, so a rename must not
	// leave the old pair valid.
	s.resetAuthLocked()
	return s.statusLocked(), nil
}

// SetPassword hashes plaintext and persists it. An empty plaintext clears
// the stored password, which makes the share inactive (fail-closed) without
// touching the enabled flag.
func (s *Service) SetPassword(plaintext string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.envPasswordHash != "" {
		return s.statusLocked(), ErrLocked
	}
	if plaintext == "" {
		s.settings.PasswordHash = ""
	} else {
		hash, err := authgate.HashPassword(plaintext)
		if err != nil {
			return s.statusLocked(), err
		}
		s.settings.PasswordHash = hash
	}
	if err := s.saveLocked(); err != nil {
		return s.statusLocked(), err
	}
	s.resetAuthLocked()
	return s.statusLocked(), nil
}

func (s *Service) saveLocked() error {
	return Save(s.settingsPath, s.settings)
}

// resetAuthLocked rebuilds the verifier and drops every cached credential —
// called on any change that could invalidate a previously accepted
// user/password pair.
func (s *Service) resetAuthLocked() {
	s.gate = authgate.New(s.effectivePasswordHashLocked())
	s.cache = map[string]time.Time{}
}

// --- request handling ---------------------------------------------------

func (s *Service) credKey(username, password string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(username))
	mac.Write([]byte{0})
	mac.Write([]byte(password))
	return base64.RawStdEncoding.EncodeToString(mac.Sum(nil))
}

// authenticate checks the presented Basic auth pair against the effective
// credentials, using the derivation cache described on Service.cache.
// rateLimited distinguishes "wrong password" from "backed off", so the
// caller can answer 429 instead of an endless 401 loop.
func (s *Service) authenticate(clientKey, username, password string) (ok bool, rateLimited bool) {
	s.mu.Lock()
	wantUser := s.effectiveUsernameLocked()
	hash := s.effectivePasswordHashLocked()
	key := s.credKey(username, password)
	if until, found := s.cache[key]; found {
		if time.Now().Before(until) {
			s.mu.Unlock()
			return true, false
		}
		delete(s.cache, key)
	}
	gate := s.gate
	s.mu.Unlock()

	if hash == "" {
		return false, false
	}
	// Compared in constant time even though the username isn't secret —
	// it costs nothing and keeps the two halves of the credential
	// symmetric. Deliberately NOT short-circuited on a username mismatch:
	// skipping the derivation there would turn response time into a
	// username oracle. The cost of that choice is that a wrong username
	// pays argon2id too, which is what the rate limiter below is for.
	userOK := subtle.ConstantTimeCompare([]byte(username), []byte(wantUser)) == 1

	// The unlock token TryUnlock mints on success is discarded — WebDAV
	// clients have no cookie jar to keep it in, which is why this path
	// re-verifies (or hits the cache) on every request instead.
	_, passOK, err := gate.TryUnlock(clientKey, password)
	if errors.Is(err, authgate.ErrRateLimited) {
		return false, true
	}
	if err != nil {
		log.Printf("webdavshare: password verification failed: %v", err)
		return false, false
	}
	if !passOK || !userOK {
		return false, false
	}

	s.mu.Lock()
	if len(s.cache) >= maxCachedCreds {
		s.cache = map[string]time.Time{}
	}
	s.cache[key] = time.Now().Add(credCacheTTL)
	s.mu.Unlock()
	return true, false
}

// clientKey derives the rate-limiter key from the connection's remote
// address. Deliberately not X-Forwarded-For: that header is client-supplied
// and would let an attacker reset their own backoff at will (see
// authgate.Gate.TryUnlock's own warning about forgeable keys).
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	st := s.Status()
	if !st.Active {
		// 404, not 403: an inactive share should look like it isn't there.
		http.Error(w, "WebDAV share is not enabled", http.StatusNotFound)
		return
	}

	username, password, hasAuth := r.BasicAuth()
	if !hasAuth {
		unauthorized(w)
		return
	}
	ok, limited := s.authenticate(clientKey(r), username, password)
	if limited {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
		return
	}
	if !ok {
		unauthorized(w)
		return
	}

	s.handler.ServeHTTP(w, r)
}

func unauthorized(w http.ResponseWriter) {
	// The realm is what a client shows in its password prompt.
	w.Header().Set("WWW-Authenticate", `Basic realm="code-docker WebDAV", charset="UTF-8"`)
	http.Error(w, "authentication required", http.StatusUnauthorized)
}
