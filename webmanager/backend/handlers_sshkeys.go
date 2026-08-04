package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"webmanager/internal/sshkeys"
)

// handleListSSHKeys returns the file's full ordered entry list (keys mixed
// with standalone "#" comment lines) — see sshkeys.Entry.
func (s *Server) handleListSSHKeys(w http.ResponseWriter, r *http.Request) {
	entries, err := sshkeys.List(s.cfg.SSHAuthorizedKeys)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
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

func (s *Server) handleUpdateSSHKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
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

	key, err := sshkeys.Update(s.cfg.SSHAuthorizedKeys, id, body.Key)
	if err != nil {
		switch {
		case errors.Is(err, sshkeys.ErrNotFound):
			writeError(w, http.StatusNotFound, "key not found")
		case errors.Is(err, sshkeys.ErrDuplicate):
			writeError(w, http.StatusConflict, err.Error())
		default:
			writeError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, key)
}

func (s *Server) handleAddSSHComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.Text) == "" {
		writeError(w, http.StatusBadRequest, "text is required")
		return
	}

	entry, err := sshkeys.AddComment(s.cfg.SSHAuthorizedKeys, body.Text)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

func (s *Server) handleUpdateSSHComment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(body.Text) == "" {
		writeError(w, http.StatusBadRequest, "text is required")
		return
	}

	entry, err := sshkeys.UpdateComment(s.cfg.SSHAuthorizedKeys, id, body.Text)
	if err != nil {
		switch {
		case errors.Is(err, sshkeys.ErrNotFound):
			writeError(w, http.StatusNotFound, "comment not found")
		default:
			writeError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleDeleteSSHComment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := sshkeys.DeleteComment(s.cfg.SSHAuthorizedKeys, id); err != nil {
		if errors.Is(err, sshkeys.ErrNotFound) {
			writeError(w, http.StatusNotFound, "comment not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleReorderSSHKeys(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	entries, err := sshkeys.Reorder(s.cfg.SSHAuthorizedKeys, body.IDs)
	if err != nil {
		switch {
		case errors.Is(err, sshkeys.ErrOrderMismatch):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, entries)
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
