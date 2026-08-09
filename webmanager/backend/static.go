package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

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
// indefinitely. Keep in sync with router/backend/static.go, which this was
// ported from (in the other direction, for this fix).
func staticHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
