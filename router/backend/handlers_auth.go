package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"router/internal/authgate"
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
	Required bool `json:"required"`
	// Source is "env" (ROUTER_MANAGER_AUTH_PASSWORD_HASH pins it, /change
	// will refuse), "file" (set via /setup, changeable via /change), or
	// "unset" (nothing configured - frontend should show first-time setup,
	// not a change-password form).
	Source        string  `json:"source"`
	Unlocked      bool    `json:"unlocked"`
	UnlockedUntil *string `json:"unlockedUntil,omitempty"` // RFC3339, only set when Unlocked
	// TrustedHosts mirrors ROUTER_MANAGER_HOSTS (router/example-env.router)
	// - the dedicated-origin hostnames router's own nginx routes straight to
	// router-manager (see nginx.default.conf's NGINX_ROUTER_MANAGER_HOSTS
	// block). Read-only here: this is a static, restart-required nginx
	// routing/security boundary, same trust level as ALLOWED_HOSTS/
	// ALLOWED_EXPORT_HOSTS, so unlike the password it's never settable via
	// this API - the frontend just displays it so a user can tell at a
	// glance whether a dedicated domain is configured. Empty when unset.
	TrustedHosts []string `json:"trustedHosts"`
	// RequestHost is the Host header this specific request arrived on -
	// lets the frontend compare "am I currently on one of TrustedHosts" and
	// warn if not (see the localhost/shared-origin banner).
	RequestHost string `json:"requestHost"`
}

// trustedHosts parses ROUTER_MANAGER_HOSTS the same way
// nginx-service.default.sh does (comma-separated, trimmed, empties
// dropped) - kept in sync by hand since one is bash and the other is Go.
func trustedHosts() []string {
	raw := os.Getenv("ROUTER_MANAGER_HOSTS")
	if raw == "" {
		return []string{}
	}
	var hosts []string
	for _, h := range strings.Split(raw, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			hosts = append(hosts, h)
		}
	}
	if hosts == nil {
		hosts = []string{}
	}
	return hosts
}

// handleAuthStatus lets the frontend know whether to show a password
// prompt at all, and if so whether the current session already satisfies
// it.
func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	resp := authStatusResponse{
		Required:     gate.Configured(),
		Source:       gate.Source(),
		TrustedHosts: trustedHosts(),
		RequestHost:  r.Host,
	}
	if until, ok := gate.UnlockedUntil(r); ok {
		resp.Unlocked = true
		formatted := until.UTC().Format(time.RFC3339)
		resp.UnlockedUntil = &formatted
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleAuthSetup sets the initial password - only works when nothing is
// configured yet (gate.Source() == "unset"). Never gated by
// RequirePassword, same reasoning as handleAuthUnlock: there's nothing to
// authenticate against until this succeeds once.
func handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := gate.SetupPassword(body.Password); err != nil {
		if errors.Is(err, authgate.ErrAlreadyConfigured) {
			writeError(w, http.StatusConflict, "password already configured - use /api/auth/change instead")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleAuthChange replaces an already-configured password, requiring the
// current one. Not wrapped in RequirePassword either - it does its own
// explicit current-password check, the same self-contained pattern as
// handleAuthUnlock.
func handleAuthChange(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.NewPassword == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := gate.ChangePassword(body.CurrentPassword, body.NewPassword); err != nil {
		switch {
		case errors.Is(err, authgate.ErrEnvPinned):
			writeError(w, http.StatusConflict, "password is set via ROUTER_MANAGER_AUTH_PASSWORD_HASH and can't be changed here")
		case errors.Is(err, authgate.ErrNotConfigured):
			writeError(w, http.StatusConflict, "no password configured yet - use /api/auth/setup instead")
		case errors.Is(err, authgate.ErrWrongPassword):
			writeError(w, http.StatusUnauthorized, "incorrect current password")
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
