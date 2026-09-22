package main

import (
	"encoding/json"
	"net"
	"net/http"
	"time"
)

// clientKey identifies the caller for authgate's rate limiting, derived
// from the TCP peer address rather than X-Forwarded-For/X-Real-IP — nginx
// doesn't rewrite those on the way in (see the security audit), so an
// attacker could otherwise reset their own lockout just by sending a
// different header value on each request.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

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

	if !s.passwordUnlock(w, r, body.Password) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type authStatusResponse struct {
	Required      bool    `json:"required"`
	Unlocked      bool    `json:"unlocked"`
	UnlockedUntil *string `json:"unlockedUntil,omitempty"` // RFC3339, only set when Unlocked
	// WebAuthn: fingerprint unlock can be enrolled on this host
	// (webauthnEnroll) / has a credential enrolled here (webauthn). Whether
	// this *browser* can do WebAuthn is the frontend's call.
	WebAuthnEnroll bool `json:"webauthnEnroll"`
	WebAuthn       bool `json:"webauthn"`
}

// handleAuthStatus lets the frontend know whether to show a password
// prompt at all, and if so whether the current session already satisfies
// it — without guessing from a 401 on some other route. UnlockedUntil lets
// the sidebar show a "잠기기까지 남은 시간" countdown instead of a bare
// unlocked/locked bool.
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	resp := authStatusResponse{Required: s.gate.Configured()}
	if rpID, ok := s.webauthnRPID(r); ok {
		resp.WebAuthnEnroll = true
		resp.WebAuthn = s.webauthn.HasCredentials(rpID)
	}
	if until, ok := s.gate.UnlockedUntil(r); ok {
		resp.Unlocked = true
		formatted := until.UTC().Format(time.RFC3339)
		resp.UnlockedUntil = &formatted
	}
	writeJSON(w, http.StatusOK, resp)
}
