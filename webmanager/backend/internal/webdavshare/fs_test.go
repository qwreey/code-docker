package webdavshare

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newOpenShare returns an enabled, password-set service over root plus a
// helper that performs one authenticated WebDAV request against it.
func newOpenShare(t *testing.T, root string) func(method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	return func(method, target, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, URLPrefix+target, strings.NewReader(body))
		req.SetBasicAuth(DefaultUsername, "s3cret")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}
}

// TestWriteThroughEscapingAncestorIsRefused is the WebDAV half of the
// symlink-escape finding: the share's own password is a *separate*, lower
// trust tier than webmanager's gate, so a write that follows an ancestor
// symlink out of the root (e.g. a repo cloned with `evil -> /` in it) would
// be a root-level write to the whole container filesystem.
func TestWriteThroughEscapingAncestorIsRefused(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "repo", "evil")); err != nil {
		t.Fatal(err)
	}
	do := newOpenShare(t, root)

	if rec := do(http.MethodPut, "/repo/evil/planted.txt", "pwned"); rec.Code < 400 {
		t.Fatalf("PUT through an escaping ancestor succeeded: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(outside, "planted.txt")); !os.IsNotExist(err) {
		t.Fatalf("PUT escaped the root: %v", err)
	}

	if rec := do("MKCOL", "/repo/evil/planted-dir", ""); rec.Code < 400 {
		t.Fatalf("MKCOL through an escaping ancestor succeeded: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(outside, "planted-dir")); !os.IsNotExist(err) {
		t.Fatalf("MKCOL escaped the root: %v", err)
	}

	if rec := do(http.MethodDelete, "/repo/evil/secret.txt", ""); rec.Code < 400 {
		t.Fatalf("DELETE through an escaping ancestor succeeded: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); err != nil {
		t.Fatalf("DELETE escaped the root: %v", err)
	}

	if rec := do(http.MethodGet, "/repo/evil/secret.txt", ""); strings.Contains(rec.Body.String(), "top secret") {
		t.Fatalf("GET through an escaping ancestor leaked content: %d", rec.Code)
	}
}

// A link that stays inside the root is ordinary content and must keep
// working — the check rejects escapes, not symlinks as such.
func TestWriteThroughInsideSymlinkStillWorks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	do := newOpenShare(t, root)

	if rec := do(http.MethodPut, "/link/ok.txt", "fine"); rec.Code >= 400 {
		t.Fatalf("PUT through an inside symlink failed: %d %q", rec.Code, rec.Body.String())
	}
	if b, err := os.ReadFile(filepath.Join(root, "real", "ok.txt")); err != nil || string(b) != "fine" {
		t.Fatalf("file not written through the inside symlink: %q %v", b, err)
	}
}
