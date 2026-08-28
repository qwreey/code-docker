package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	saved := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		done <- string(out)
	}()
	fn()
	w.Close()
	os.Stdout = saved
	return <-done
}

// gatedSessionsServer answers the two endpoints listSessionsCmd calls, with
// the sessions list requiring the unlock cookie.
func gatedSessionsServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"required":true,"unlocked":false}`)
	})
	mux.HandleFunc("/api/terminal/sessions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "webmanager_unlock=tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `[{"name":"quad"},{"name":"세션 1"}]`)
	})
	return httptest.NewServer(mux)
}

// With the password gate on, `webmanager --list-sessions` used to bail
// unconditionally, leaving `attach`'s shell completion with no candidates
// at all - which is how an unquoted `attach 세션 1` (name + start-dir)
// silently created a session named "세션" instead of joining the intended
// one. It now answers the gate with the cookie the last attach cached.
func TestListSessionsUsesCachedCookieUnderGate(t *testing.T) {
	srv := gatedSessionsServer(t)
	defer srv.Close()

	cookiePath := filepath.Join(t.TempDir(), "attach-cookie")
	saveAttachCookie(cookiePath, "webmanager_unlock=tok")

	cfg := Config{Addr: strings.TrimPrefix(srv.URL, "http://"), AttachCookiePath: cookiePath}
	var rc int
	out := captureStdout(t, func() { rc = listSessionsCmd(cfg) })
	if rc != 0 {
		t.Errorf("rc = %d, want 0", rc)
	}
	if out != "quad\n세션 1\n" {
		t.Errorf("output = %q, want the two session names", out)
	}
}

// No cached cookie (or a stale one the gate rejects) still means "offer
// nothing", never an error or a prompt firing mid-TAB.
func TestListSessionsSilentWithoutUsableCookie(t *testing.T) {
	srv := gatedSessionsServer(t)
	defer srv.Close()

	dir := t.TempDir()
	for _, c := range []struct {
		name   string
		cookie string
	}{
		{"no cookie file", ""},
		{"stale cookie", "webmanager_unlock=expired"},
	} {
		cookiePath := filepath.Join(dir, "cookie-"+c.name)
		if c.cookie != "" {
			saveAttachCookie(cookiePath, c.cookie)
		}
		cfg := Config{Addr: strings.TrimPrefix(srv.URL, "http://"), AttachCookiePath: cookiePath}
		var rc int
		out := captureStdout(t, func() { rc = listSessionsCmd(cfg) })
		if rc != 0 || out != "" {
			t.Errorf("%s: rc = %d, output = %q, want 0 and empty", c.name, rc, out)
		}
	}
}

func TestSaveAttachCookieIsRootOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "attach-cookie")
	saveAttachCookie(path, "webmanager_unlock=tok")

	if got := loadAttachCookie(path); got != "webmanager_unlock=tok" {
		t.Errorf("loadAttachCookie = %q, want the stored cookie", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 600", perm)
	}
}
