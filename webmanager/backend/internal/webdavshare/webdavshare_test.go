package webdavshare

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestService(t *testing.T, root string, opts Options) *Service {
	t.Helper()
	if opts.SettingsPath == "" {
		opts.SettingsPath = filepath.Join(t.TempDir(), "webdav.json")
	}
	opts.Root = root
	return New(opts)
}

func TestDisabledShareIsNotFound(t *testing.T) {
	s := newTestService(t, t.TempDir(), Options{})

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, URLPrefix+"/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("disabled share returned %d, want 404", rec.Code)
	}
}

// Enabling without a password must stay fail-closed: the toggle is stored
// (so the tab can be filled in either order) but nothing is served.
func TestEnabledWithoutPasswordStaysClosed(t *testing.T) {
	s := newTestService(t, t.TempDir(), Options{})
	st, err := s.SetEnabled(true)
	if err != nil {
		t.Fatalf("SetEnabled() = %v", err)
	}
	if st.Active {
		t.Fatal("share reported active with no password set")
	}
	if st.Reason == "" {
		t.Fatal("inactive share gave no reason")
	}

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, URLPrefix+"/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("passwordless share returned %d, want 404", rec.Code)
	}
}

func TestBasicAuthGatesTheShare(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatalf("SetPassword() = %v", err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled() = %v", err)
	}

	// No credentials at all.
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, URLPrefix+"/hello.txt", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-auth request returned %d, want 401", rec.Code)
	}
	if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Basic ") {
		t.Fatalf("missing Basic challenge, got %q", rec.Header().Get("WWW-Authenticate"))
	}

	// Wrong password.
	req := httptest.NewRequest(http.MethodGet, URLPrefix+"/hello.txt", nil)
	req.SetBasicAuth(DefaultUsername, "wrong")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-password request returned %d, want 401", rec.Code)
	}

	// Right password, wrong username.
	req = httptest.NewRequest(http.MethodGet, URLPrefix+"/hello.txt", nil)
	req.SetBasicAuth("someone-else", "s3cret")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-username request returned %d, want 401", rec.Code)
	}

	// Correct pair.
	req = httptest.NewRequest(http.MethodGet, URLPrefix+"/hello.txt", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authorized request returned %d, want 200", rec.Code)
	}
	if rec.Body.String() != "hi" {
		t.Fatalf("body = %q, want %q", rec.Body.String(), "hi")
	}
}

// A second identical request must be served from the credential cache
// rather than re-deriving argon2id — the difference between a usable share
// and one that spends 64 MiB per PROPFIND.
func TestSuccessfulAuthIsCached(t *testing.T) {
	root := t.TempDir()
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}

	if ok, _ := s.authenticate("test", DefaultUsername, "s3cret"); !ok {
		t.Fatal("first authenticate() failed")
	}
	s.mu.Lock()
	cached := len(s.cache)
	s.mu.Unlock()
	if cached != 1 {
		t.Fatalf("cache holds %d entries after a success, want 1", cached)
	}

	// Changing the password must invalidate it, or the old credential would
	// keep working for up to credCacheTTL.
	if _, err := s.SetPassword("different"); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	cached = len(s.cache)
	s.mu.Unlock()
	if cached != 0 {
		t.Fatalf("cache holds %d entries after a password change, want 0", cached)
	}
	if ok, _ := s.authenticate("test", DefaultUsername, "s3cret"); ok {
		t.Fatal("the old password still authenticates after a change")
	}
}

func TestEnvValuesPinFields(t *testing.T) {
	s := newTestService(t, t.TempDir(), Options{
		EnvEnabled:      "true",
		EnvUsername:     "fixed",
		EnvPasswordHash: "$argon2id$v=19$m=65536,t=3,p=2$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGg",
	})
	st := s.Status()
	if !st.Enabled || st.Username != "fixed" || !st.HasPassword {
		t.Fatalf("env values not applied: %+v", st)
	}
	if !st.EnabledLocked || !st.UsernameLocked || !st.PasswordLocked {
		t.Fatalf("env-provided fields not reported as locked: %+v", st)
	}
	for name, err := range map[string]error{
		"SetEnabled":  mustErr(s.SetEnabled(false)),
		"SetUsername": mustErr(s.SetUsername("other")),
		"SetPassword": mustErr(s.SetPassword("nope")),
	} {
		if err != ErrLocked {
			t.Fatalf("%s on a pinned field returned %v, want ErrLocked", name, err)
		}
	}
}

// "false" has to actually mean off — an env var is also how an operator
// force-disables a share whose settings file says enabled.
func TestEnvEnabledFalseWins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "webdav.json")
	if err := Save(path, Settings{Enabled: true, PasswordHash: "x"}); err != nil {
		t.Fatal(err)
	}
	s := New(Options{SettingsPath: path, Root: t.TempDir(), EnvEnabled: "false"})
	if s.Status().Enabled {
		t.Fatal("WEBMANAGER_WEBDAV_ENABLED=false did not override the settings file")
	}
}

func mustErr(_ Status, err error) error { return err }

func TestSettingsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "webdav.json")
	want := Settings{Enabled: true, Username: "u", PasswordHash: "h"}
	if err := Save(path, want); err != nil {
		t.Fatalf("Save() = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings file mode = %v, want 0600 (it holds a password hash)", info.Mode().Perm())
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load() = %v", err)
	}
	if got != want {
		t.Fatalf("Load() = %+v, want %+v", got, want)
	}
}

func TestLoadMissingFileIsNotAnError(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("Load() on a missing file = %v, want nil", err)
	}
	if got != (Settings{}) {
		t.Fatalf("Load() = %+v, want the zero value", got)
	}
}

func TestUsernameRejectsColon(t *testing.T) {
	s := newTestService(t, t.TempDir(), Options{})
	if _, err := s.SetUsername("bad:name"); err == nil {
		t.Fatal("a username containing ':' was accepted")
	}
}

// A symlink pointing outside the share root must not be readable through
// it — the one thing this package borrows from internal/files.
func TestSymlinkEscapeIsRefused(t *testing.T) {
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Symlink(secret, filepath.Join(root, "escape.txt")); err != nil {
		t.Fatal(err)
	}

	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, URLPrefix+"/escape.txt", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("a symlink out of the root was served: %q", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "top secret") {
		t.Fatal("symlink target content leaked into the response")
	}
}

// `..` traversal is webdav.Dir's own job, but it's the obvious thing to
// regress if this package ever stops delegating to it.
func TestParentTraversalIsContained(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(outside, "share")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}

	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, URLPrefix+"/../secret.txt", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "top secret") {
		t.Fatalf("`..` traversal escaped the root: %d %q", rec.Code, rec.Body.String())
	}
}
