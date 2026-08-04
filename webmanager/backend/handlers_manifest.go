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
// sensitive data) — see config/nginx.default.conf's
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
