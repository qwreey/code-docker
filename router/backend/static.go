package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// staticHandler serves router/frontend's pre-built SPA assets from dir. Any
// GET path that doesn't map to a real file falls back to index.html (client-
// side routing - the SPA itself has none today, but this keeps a reload on
// any sub-path working regardless) - and if dir/index.html doesn't exist
// either (e.g. the frontend hasn't been built into place yet), it 404s
// instead of panicking. Ported verbatim from webmanager/backend/static.go.
func staticHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(requested); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		index := filepath.Join(dir, "index.html")
		if _, err := os.Stat(index); err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, index)
	})
}
