// Package manifestpatch fetches code-server's real PWA manifest.json and
// merges in the "shortcuts" entries — webmanager's own, plus whatever a side
// project declared through WEBMANAGER_MANIFEST_SHORTCUT_* (see
// shortcuts.go) — without touching the
// vendored code-server-autoinstall route that actually serves it — see
// webmanager/.claude/qa-request/manifest-shortcuts-plan-done.md for the full
// design/rationale. Every field other than "shortcuts" passes through
// exactly as fetched (name/icons/start_url/scope/display/...) so upstream
// code-server changes are picked up automatically instead of drifting out
// of sync with a hand-maintained copy — including PWA_NAME/PWA_SHORT_NAME/
// PWA_DISPLAY_MODE, which code-server-autoinstall's own start.sh patches
// directly into the manifest route at install time, so there is nothing
// left for this package to override.
package manifestpatch

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// managerShortcut is the one "shortcuts" entry this package injects — a
// jump-list item that opens webmanager's own path. No "icons" (optional per
// spec; falls back to text/default icon).
var managerShortcut = map[string]any{
	"name":        "Open manager",
	"short_name":  "Manager",
	"url":         "/manager/",
	"description": "webmanager 관리 패널 열기",
}

var httpClient = &http.Client{Timeout: 5 * time.Second}

// Fetch retrieves code-server's manifest from upstreamURL, merges in
// managerShortcut under "shortcuts", and returns the re-serialized JSON
// bytes. Any failure (network error, non-200 response, JSON parse failure)
// is returned as an error and nothing else — callers are expected to
// respond with a bare 502 on error (see handleManifestPassthrough), which
// is what lets nginx's error_page fallback catch it and retry directly
// against code-server. No fallback logic belongs in this package.
func Fetch(upstreamURL string) ([]byte, error) {
	resp, err := httpClient.Get(upstreamURL)
	if err != nil {
		return nil, fmt.Errorf("manifestpatch: fetch %s: %w", upstreamURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifestpatch: upstream %s returned status %d", upstreamURL, resp.StatusCode)
	}

	var manifest map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("manifestpatch: parse upstream manifest from %s: %w", upstreamURL, err)
	}

	shortcuts := []any{managerShortcut}
	for _, sc := range Extra() {
		entry := map[string]any{
			"name": sc.Name,
			"url":  sc.ManifestURL(),
		}
		if sc.Description != "" {
			entry["description"] = sc.Description
		}
		shortcuts = append(shortcuts, entry)
	}
	// Not capped here even though browsers only draw the first few (Chrome
	// and Edge settle on four): the cap is a presentation detail of whatever
	// is reading the manifest, and dropping a configured entry on our side
	// would be this package deciding the user's fifth shortcut does not
	// exist. Documented in docs/webmanager-config.md instead.
	manifest["shortcuts"] = shortcuts

	patched, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("manifestpatch: re-serialize patched manifest: %w", err)
	}
	return patched, nil
}
