package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/termsession"
)

func writeTermSessionErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, termsession.ErrSessionGone):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, termsession.ErrInvalidName):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) handleListTerminalSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.termSessions.List())
}

type patchTerminalSessionRequest struct {
	Pinned bool `json:"pinned"`
}

func (s *Server) handlePatchTerminalSession(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	var body patchTerminalSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := s.termSessions.SetPinned(name, body.Pinned); err != nil {
		writeTermSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteTerminalSession(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.termSessions.Remove(name); err != nil {
		writeTermSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
