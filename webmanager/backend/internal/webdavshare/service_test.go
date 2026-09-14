package webdavshare

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// See the H1 fix in service.go's ServeHTTP: GET/HEAD must not let an
// uploaded HTML/SVG file render inline on this container's own origin.

func TestGetResponseForcesAttachmentAndNosniff(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "evil.html"), []byte("<script>alert(1)</script>"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatalf("SetPassword() = %v", err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled() = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, URLPrefix+"/evil.html", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET evil.html = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename=evil.html` {
		t.Errorf("Content-Disposition = %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	// Content-Type is still extension-sniffed by http.ServeContent - that's
	// unchanged and fine, since attachment+nosniff together are what stop a
	// browser from rendering the body regardless of what this says.
	if got := rec.Header().Get("Content-Type"); got == "" {
		t.Error("Content-Type missing")
	}
}

func TestHeadResponseAlsoGetsHeaders(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatalf("SetPassword() = %v", err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled() = %v", err)
	}

	req := httptest.NewRequest(http.MethodHead, URLPrefix+"/file.txt", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename=file.txt` {
		t.Errorf("Content-Disposition = %q", got)
	}
}

// PROPFIND (and every other non-content method) must be untouched - a
// WebDAV client's directory listing has no business carrying a download
// disposition, and forcing one on an XML body would be actively wrong.
func TestPropfindDoesNotGetAttachment(t *testing.T) {
	root := t.TempDir()
	s := newTestService(t, root, Options{})
	if _, err := s.SetPassword("s3cret"); err != nil {
		t.Fatalf("SetPassword() = %v", err)
	}
	if _, err := s.SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled() = %v", err)
	}

	req := httptest.NewRequest("PROPFIND", URLPrefix+"/", nil)
	req.SetBasicAuth(DefaultUsername, "s3cret")
	req.Header.Set("Depth", "0")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Disposition"); got != "" {
		t.Errorf("PROPFIND got Content-Disposition = %q, want none", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "" {
		t.Errorf("PROPFIND got X-Content-Type-Options = %q, want none", got)
	}
}

func TestContentDispositionAttachmentSanitizesName(t *testing.T) {
	cases := map[string]string{
		"/webdav/evil.html":        `attachment; filename=evil.html`,
		"/webdav/":                 `attachment; filename=download`,
		"/webdav/a\r\nb.txt":       `attachment; filename=ab.txt`,
		"/webdav/with space.html":  `attachment; filename="with space.html"`,
		"/webdav/sub/dir/name.svg": `attachment; filename=name.svg`,
	}
	for path, want := range cases {
		if got := contentDispositionAttachment(path); got != want {
			t.Errorf("contentDispositionAttachment(%q) = %q, want %q", path, got, want)
		}
	}
}
