package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"webmanager/internal/sshkeys"
)

func (s *Server) handleListSSHKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := sshkeys.List(s.cfg.SSHAuthorizedKeys)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) handleAddSSHKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.Key) == "" {
		writeError(w, http.StatusBadRequest, "key is required")
		return
	}

	key, err := sshkeys.Add(s.cfg.SSHAuthorizedKeys, body.Key)
	if err != nil {
		if errors.Is(err, sshkeys.ErrDuplicate) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, key)
}

func (s *Server) handleDeleteSSHKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := sshkeys.Delete(s.cfg.SSHAuthorizedKeys, id); err != nil {
		if errors.Is(err, sshkeys.ErrNotFound) {
			writeError(w, http.StatusNotFound, "key not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
