package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"webmanager/internal/authgate"
	"webmanager/internal/webauthnunlock"
)

// Fingerprint (WebAuthn) unlock for the password gate - see
// internal/webauthnunlock's package doc for the rules. s.webauthn is nil
// whenever the gate isn't configured or WEBMANAGER_WEBAUTHN_ENABLED=false;
// every handler here then answers 404, and /api/auth/status says so.

// webauthnRPID is the request's own hostname, or ok=false when WebAuthn
// can't work here at all (no manager, or an IP-address host).
func (s *Server) webauthnRPID(r *http.Request) (string, bool) {
	if s.webauthn == nil {
		return "", false
	}
	return webauthnunlock.RPIDFromHost(r.Host)
}

func (s *Server) webauthnUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "fingerprint unlock is not available here")
}

// POST /api/auth/webauthn/register/begin {password, label}
//
// Enrollment asks for the password itself rather than trusting an unlocked
// cookie: a cookie can be ten idle minutes old on an unattended screen, and
// a credential enrolled from it would outlive that unlock by months. The
// frontend offers enrollment right after a password unlock, still holding
// what was typed, so in practice nobody types it twice. A correct password
// here is a real password unlock too (cookie, and the 12h window restarts).
func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	rpID, ok := s.webauthnRPID(r)
	if !ok {
		s.webauthnUnavailable(w)
		return
	}
	var body struct {
		Password string `json:"password"`
		Label    string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !s.passwordUnlock(w, r, body.Password) {
		return
	}
	label := strings.TrimSpace(body.Label)
	if len(label) > 80 {
		label = label[:80]
	}
	if label == "" {
		label = "이 기기"
	}
	creation, ceremony, err := s.webauthn.BeginRegistration(rpID, label)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony": ceremony, "options": creation})
}

// POST /api/auth/webauthn/register/finish?ceremony=<id>, body = the
// browser's PublicKeyCredential as JSON.
func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	rpID, ok := s.webauthnRPID(r)
	if !ok {
		s.webauthnUnavailable(w)
		return
	}
	if err := s.webauthn.FinishRegistration(r.URL.Query().Get("ceremony"), rpID, r.Body); err != nil {
		log.Printf("webauthn: registration on %s failed: %v", rpID, err)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	log.Printf("webauthn: new credential enrolled for %s", rpID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// POST /api/auth/webauthn/unlock/begin. Ungated (it *is* an unlock), but
// shares the password path's per-IP backoff.
func (s *Server) handleWebAuthnUnlockBegin(w http.ResponseWriter, r *http.Request) {
	rpID, ok := s.webauthnRPID(r)
	if !ok {
		s.webauthnUnavailable(w)
		return
	}
	if err := s.gate.CheckAttempt(clientKey(r)); err != nil {
		writeError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	// Checked up front so the browser prompt isn't shown for an unlock that
	// would be refused anyway.
	if _, ok := s.gate.IssueFrom(s.webauthn.PasswordAt()); !ok {
		writeError(w, http.StatusConflict, "password required: fingerprint unlock only works within 12 hours of the last password unlock")
		return
	}
	assertion, ceremony, err := s.webauthn.BeginUnlock(rpID)
	if err != nil {
		if errors.Is(err, webauthnunlock.ErrNoCredentials) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony": ceremony, "options": assertion})
}

// POST /api/auth/webauthn/unlock/finish?ceremony=<id>
func (s *Server) handleWebAuthnUnlockFinish(w http.ResponseWriter, r *http.Request) {
	rpID, ok := s.webauthnRPID(r)
	if !ok {
		s.webauthnUnavailable(w)
		return
	}
	key := clientKey(r)
	if err := s.gate.CheckAttempt(key); err != nil {
		writeError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	if err := s.webauthn.FinishUnlock(r.URL.Query().Get("ceremony"), rpID, r.Body); err != nil {
		s.gate.RecordFailure(key)
		log.Printf("webauthn: unlock on %s failed: %v", rpID, err)
		writeError(w, http.StatusUnauthorized, "fingerprint unlock failed")
		return
	}
	token, ok := s.gate.IssueFrom(s.webauthn.PasswordAt())
	if !ok {
		writeError(w, http.StatusConflict, "password required: fingerprint unlock only works within 12 hours of the last password unlock")
		return
	}
	s.gate.RecordSuccess(key)
	s.gate.SetCookie(w, r, token)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// GET /api/auth/webauthn/credentials (gated)
func (s *Server) handleWebAuthnCredentials(w http.ResponseWriter, r *http.Request) {
	if s.webauthn == nil {
		s.webauthnUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, s.webauthn.List())
}

// DELETE /api/auth/webauthn/credentials/{id} (gated)
func (s *Server) handleWebAuthnCredentialDelete(w http.ResponseWriter, r *http.Request) {
	if s.webauthn == nil {
		s.webauthnUnavailable(w)
		return
	}
	if err := s.webauthn.Delete(r.PathValue("id")); err != nil {
		if errors.Is(err, webauthnunlock.ErrNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// passwordUnlock checks a typed password exactly the way POST
// /api/auth/unlock does - backoff, cookie, and the WebAuthn window's start -
// writing the error response itself when it fails.
func (s *Server) passwordUnlock(w http.ResponseWriter, r *http.Request, password string) bool {
	token, ok, err := s.gate.TryUnlock(clientKey(r), password)
	if err != nil {
		if errors.Is(err, authgate.ErrRateLimited) {
			writeError(w, http.StatusTooManyRequests, err.Error())
			return false
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "incorrect password")
		return false
	}
	s.gate.SetCookie(w, r, token)
	if s.webauthn != nil {
		s.webauthn.RecordPasswordUnlock(time.Now())
	}
	return true
}
