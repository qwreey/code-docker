package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

// With the password gate on, `webmanager --list-sessions` used to go silent
// unless a cookie cached by an earlier `attach` was still valid, leaving
// `attach`'s shell completion with no candidates most of the time - which is
// how an unquoted `attach 세션 1` (name + start-dir) silently created a
// session named "세션" instead of joining the intended one. It now reads the
// ungated names-only endpoint and sends no credentials at all.
func TestListSessionsPrintsNamesWithoutCredentials(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminal/session-names" || r.Header.Get("Cookie") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `["quad","세션 1"]`)
	}))
	defer srv.Close()

	cfg := Config{Addr: strings.TrimPrefix(srv.URL, "http://")}
	var rc int
	out := captureStdout(t, func() { rc = listSessionsCmd(cfg) })
	if rc != 0 {
		t.Errorf("rc = %d, want 0", rc)
	}
	if out != "quad\n세션 1\n" {
		t.Errorf("output = %q, want the two session names", out)
	}
}

// Any failure still means "offer nothing", never an error or a hang firing
// mid-TAB.
func TestListSessionsSilentOnFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	for _, addr := range []string{strings.TrimPrefix(srv.URL, "http://"), "127.0.0.1:1"} {
		var rc int
		out := captureStdout(t, func() { rc = listSessionsCmd(Config{Addr: addr}) })
		if rc != 0 || out != "" {
			t.Errorf("%s: rc = %d, output = %q, want 0 and empty", addr, rc, out)
		}
	}
}
