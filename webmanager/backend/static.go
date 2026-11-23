package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// spaCSP is the second line behind an XSS sink that doesn't exist today:
// the build already loads every script from its own files (no inline
// script, eval or javascript: URL), so the policy pins only that, plus no
// plugins and no <base> to re-point relative URLs. Styles and frames stay
// open - CodeMirror and xterm insert <style> elements, and the router and
// provider embeds can sit on other origins. Set on every file this serves,
// not only index.html: favicon.svg is a document too when opened directly.
// Provider pages are proxied elsewhere (handlers_providers.go) and keep
// their own policy.
const spaCSP = "script-src 'self'; object-src 'none'; base-uri 'none'"

// staticHandler serves pre-built frontend assets from dir. Any GET path that
// doesn't map to a real file falls back to index.html (SPA client-side
// routing) — and if dir/index.html doesn't exist either (e.g. the frontend
// hasn't been built into place yet), it 404s instead of panicking.
//
// index.html always gets Cache-Control: no-cache (forces revalidation) —
// it's the one file whose content changes on every rebuild (new hashed
// asset filenames) while keeping the same URL, so letting a browser cache
// it beyond that would leave it referencing assets a later rebuild has
// already deleted, and a request for the missing hashed asset would fall
// through to this handler's own SPA-fallback branch below and get
// index.html back with a text/html Content-Type instead. Files under
// assets/ are Vite's hashed, content-addressed bundle output (a changed
// file always gets a new filename), so those are safe to cache
// indefinitely. Keep in sync with router-docker's own backend/static.go, which this was
// ported from (in the other direction, for this fix).
func staticHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", spaCSP)
		requested := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(requested); err == nil && !info.IsDir() {
			if strings.HasPrefix(filepath.ToSlash(r.URL.Path), "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		index := filepath.Join(dir, "index.html")
		if _, err := os.Stat(index); err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}
