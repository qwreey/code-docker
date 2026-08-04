package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// handleAuthUnlock verifies a submitted password against the configured
// gate hash and, on success, issues an unlock cookie. Never itself wrapped
// in RequirePassword (a locked-out client obviously needs to reach this to
// unlock).
func (s *Server) handleAuthUnlock(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, ok, err := s.gate.TryUnlock(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "incorrect password")
		return
	}

	s.gate.SetCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type authStatusResponse struct {
	Required      bool    `json:"required"`
	Unlocked      bool    `json:"unlocked"`
	UnlockedUntil *string `json:"unlockedUntil,omitempty"` // RFC3339, only set when Unlocked
}

// handleAuthStatus lets the frontend know whether to show a password
// prompt at all, and if so whether the current session already satisfies
// it — without guessing from a 401 on some other route. UnlockedUntil lets
// the sidebar show a "잠기기까지 남은 시간" countdown instead of a bare
// unlocked/locked bool.
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	resp := authStatusResponse{Required: s.gate.Configured()}
	if until, ok := s.gate.UnlockedUntil(r); ok {
		resp.Unlocked = true
		formatted := until.UTC().Format(time.RFC3339)
		resp.UnlockedUntil = &formatted
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleAuthVerify is the Caddy forward_auth upstream for internal/devproxy's
// dev-proxy exposes (see docs/dev-proxy.md). Caddy calls this with a GET
// request carrying X-Forwarded-{Proto,Host,Uri} for the original request —
// a 2xx response lets the request through, anything else is relayed back to
// the browser as-is (see forward_auth's documented protocol). This
// deliberately never sets any copy_headers-style response header derived
// from client input — see internal/authgate's package doc and
// GHSA-7r4p-vjf4-gxv4 for why that combination is dangerous; if a future
// change adds one, it must be set unconditionally on every response, not
// only when authorized.
//
// Checked against UnlockedForForwardAuth (a much longer TTL than the
// write-gate's Unlocked), not RequirePassword — this endpoint gates
// read-only dev-proxy browsing, not a destructive webmanager action. Passes
// through unconditionally when the gate isn't configured at all, same as
// RequirePassword — otherwise an expose with "인증 요구" checked would
// redirect to a login page that TryUnlock can never satisfy (it also
// requires Configured()), looping forever.
func (s *Server) handleAuthVerify(w http.ResponseWriter, r *http.Request) {
	if !s.gate.Configured() || s.gate.UnlockedForForwardAuth(r) {
		w.WriteHeader(http.StatusOK)
		return
	}
	if loc := s.buildDevAuthRedirect(r); loc != "" {
		w.Header().Set("Location", loc)
		w.WriteHeader(http.StatusFound)
		return
	}
	// No WEBMANAGER_CODE_SERVER_URL configured — there's no absolute URL to
	// send the browser to, so fail closed instead of redirecting nowhere.
	w.WriteHeader(http.StatusUnauthorized)
}

// buildDevAuthRedirect returns an absolute URL to webmanager's standalone
// dev-auth login page, carrying the original dev-proxy request (from
// Caddy's X-Forwarded-* headers) as the rd query param to return to after
// login. Returns "" if WEBMANAGER_CODE_SERVER_URL isn't configured — this
// feature has no way to construct an absolute URL server-side without it
// (unlike the frontend's window.location.origin fallback elsewhere).
func (s *Server) buildDevAuthRedirect(r *http.Request) string {
	base := strings.TrimRight(s.cfg.CodeServerURL, "/")
	if base == "" {
		return ""
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	host := r.Header.Get("X-Forwarded-Host")
	uri := r.Header.Get("X-Forwarded-Uri")
	original := proto + "://" + host + uri

	u, err := url.Parse(base + "/manager/dev-auth")
	if err != nil {
		return ""
	}
	q := u.Query()
	q.Set("rd", original)
	u.RawQuery = q.Encode()
	return u.String()
}
