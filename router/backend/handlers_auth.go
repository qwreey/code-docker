package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// handleAuthUnlock verifies a submitted password against the configured
// gate hash and, on success, issues an unlock cookie. Never itself wrapped
// in gate.RequirePassword — a locked-out client obviously needs to reach
// this to unlock.
func handleAuthUnlock(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, ok, err := gate.TryUnlock(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "incorrect password")
		return
	}

	gate.SetCookie(w, token)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type authStatusResponse struct {
	Required      bool    `json:"required"`
	Unlocked      bool    `json:"unlocked"`
	UnlockedUntil *string `json:"unlockedUntil,omitempty"` // RFC3339, only set when Unlocked
}

// handleAuthStatus lets the frontend know whether to show a password
// prompt at all, and if so whether the current session already satisfies
// it.
func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	resp := authStatusResponse{Required: gate.Configured()}
	if until, ok := gate.UnlockedUntil(r); ok {
		resp.Unlocked = true
		formatted := until.UTC().Format(time.RFC3339)
		resp.UnlockedUntil = &formatted
	}
	writeJSON(w, http.StatusOK, resp)
}
