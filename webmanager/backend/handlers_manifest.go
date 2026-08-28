package main

import (
	"log"
	"net/http"

	"webmanager/internal/manifestpatch"
)

// handleManifestPassthrough fetches code-server's real /manifest.json,
// merges in a "shortcuts" entry that opens webmanager, and serves the
// patched result. Registered at GET /manifest.json (no /api prefix, no
// gate — code-server already serves this unauthenticated and it carries no
// sensitive data) — see config/nginx/nginx.default.conf's
// `location = /manifest.json`, which is what routes browser requests here
// instead of straight to code-server, and
// webmanager/.claude/qa-request/manifest-shortcuts-plan-done.md for the
// full design.
//
// Any failure (fetch error, non-200 upstream, JSON parse failure) responds
// with exactly HTTP 502 and no body, deliberately — nginx's
// `error_page 502 503 504 = @manifest_fallback` on that location catches
// this (and webmanager being down entirely) and retries directly against
// code-server, so this handler intentionally builds no fallback of its own.
func (s *Server) handleManifestPassthrough(w http.ResponseWriter, r *http.Request) {
	patched, err := manifestpatch.Fetch(s.cfg.CodeServerManifestURL)
	if err != nil {
		log.Printf("handleManifestPassthrough: %v", err)
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Write(patched)
}

// handleGoto redirects /goto/<id> to the URL that the matching
// WEBMANAGER_MANIFEST_SHORTCUT_<ID> declared. It exists because a manifest
// shortcut cannot point at another origin — see manifestpatch.GotoPrefix for
// why — so an entry aimed at, say, a Trilium container on its own hostname
// is published as this same-origin path and lands there via a redirect.
//
// Not an open redirect: the destination comes only from this container's own
// environment, and there is deliberately no query parameter to name one.
// Ungated for the same reason the manifest passthrough is — it carries
// nothing but a hostname the browser is about to be sent to anyway — and it
// leaks nothing on its own, since reaching the target still means passing
// whatever auth sits in front of that hostname.
func (s *Server) handleGoto(w http.ResponseWriter, r *http.Request) {
	sc, ok := manifestpatch.Lookup(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	// 302, not 301: the mapping is env, and a permanently-cached redirect
	// would outlive a changed hostname in every browser that had followed it
	// once.
	http.Redirect(w, r, sc.Target, http.StatusFound)
}
