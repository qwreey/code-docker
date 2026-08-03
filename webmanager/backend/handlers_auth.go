package main

import (
	"encoding/json"
	"net/http"
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
