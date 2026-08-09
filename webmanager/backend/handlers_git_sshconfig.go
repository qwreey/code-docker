package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/gitconfig"
)

// handleGetSSHConfigRaw / handlePutSSHConfigRaw are gated on reads too
// (unlike RawConfigEditor's GET /api/git/config/raw, which is read-open) —
// see main.go's route registration comment for why: ssh_config can carry
// ProxyJump hosts, usernames, and internal hostnames that shouldn't be
// readable without unlocking, the same reasoning as GET /api/files/content.
func (s *Server) handleGetSSHConfigRaw(w http.ResponseWriter, r *http.Request) {
	content, err := gitconfig.ReadRawSSHConfig(s.cfg.SSHClientConfig)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

func (s *Server) handlePutSSHConfigRaw(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := gitconfig.WriteRawSSHConfig(s.cfg.SSHClientConfig, body.Content); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleGetSSHDefaultKey is intentionally ungated (unlike the raw config
// above) — it only ever returns a public key, which is meant to be shared,
// the same tier as GET /api/git/gpg-keys/{keyId}/public.
func (s *Server) handleGetSSHDefaultKey(w http.ResponseWriter, r *http.Request) {
	exists, pub, err := gitconfig.SSHDefaultKeyStatus(s.cfg.SSHDefaultKeyPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exists": exists, "publicKey": pub})
}

func (s *Server) handleGenerateSSHDefaultKey(w http.ResponseWriter, r *http.Request) {
	pub, err := gitconfig.GenerateSSHDefaultKey(s.cfg.SSHDefaultKeyPath)
	if err != nil {
		if errors.Is(err, gitconfig.ErrDefaultKeyExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"publicKey": pub})
}
