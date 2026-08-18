package main

import (
	"encoding/json"
	"net/http"
)

// handleWebmanagerManifest serves a small, independent PWA manifest for
// webmanager's own /manager/ page (frontend/index.html links to it via
// <link rel="manifest" href="/manager/webmanager-manifest.json">).
//
// This is deliberately a SEPARATE resource from GET /manifest.json
// (handleManifestPassthrough, handlers_manifest.go) — that one is
// code-server's own real manifest, only merged with a "shortcuts" jump-list
// entry that opens /manager/. A manifest `shortcuts` item has no `display`
// field of its own (not part of the Web App Manifest spec) — tapping it
// always launches inside the already-installed app using *that app's*
// display mode. So as long as "Open manager" stays a shortcut into
// code-server's installed PWA, there is no way to give it different browser
// chrome than code-server itself without changing code-server's own display
// mode too — which is explicitly out of scope (code-server is expected to
// hide browser chrome; only webmanager should get a way to keep it visible).
// A genuinely separate manifest, scoped to /manager/ and installed by
// visiting /manager/ directly and using the browser's own "Add to Home
// Screen"/"Install" action there, is the only mechanism that avoids
// touching code-server's manifest at all. The pre-existing "Open manager"
// shortcut in code-server's manifest is untouched and still works exactly
// as before — this is a purely additive, separate install path.
//
// WEBMANAGER_PWA_DISPLAY_MODE (Config.PWADisplayMode, default "browser")
// controls the `display` field. Like any manifest `display` field, browsers
// only read this at "Add to Home Screen"/install time — changing it later
// has no effect on a shortcut a user already installed; they need to remove
// and re-add it to pick up a new value.
func (s *Server) handleWebmanagerManifest(w http.ResponseWriter, r *http.Request) {
	manifest := map[string]any{
		"name":        "webmanager",
		"short_name":  "manager",
		"start_url":   "/manager/",
		"scope":       "/manager/",
		"display":     s.cfg.PWADisplayMode,
		"description": "code-docker webmanager admin panel",
		"icons": []map[string]any{
			{
				"src":     "/manager/favicon.svg",
				"type":    "image/svg+xml",
				"sizes":   "any",
				"purpose": "any",
			},
		},
	}

	w.Header().Set("Content-Type", "application/manifest+json")
	_ = json.NewEncoder(w).Encode(manifest)
}
