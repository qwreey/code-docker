package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Every response carries the CSP: the SPA fallback (index.html for any
// client-side route), index.html itself, and a plain file like the favicon.
func TestStaticHandlerSetsCSP(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"index.html": "<!doctype html>", "favicon.svg": "<svg/>"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := staticHandler(dir)
	for _, path := range []string{"/", "/projects/some-route", "/favicon.svg"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d", path, rec.Code)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != spaCSP {
			t.Errorf("GET %s: Content-Security-Policy = %q, want %q", path, got, spaCSP)
		}
	}
}
