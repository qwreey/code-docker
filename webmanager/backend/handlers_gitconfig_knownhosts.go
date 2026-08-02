package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"webmanager/internal/gitconfig"
)

func (s *Server) handleListKnownHosts(w http.ResponseWriter, r *http.Request) {
	entries, err := gitconfig.ListKnownHosts(s.cfg.SSHKnownHostsPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleAddKnownHost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Line string `json:"line"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := gitconfig.AddKnownHost(s.cfg.SSHKnownHostsPath, body.Line); err != nil {
		if errors.Is(err, gitconfig.ErrInvalidKnownHost) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	entries, err := gitconfig.ListKnownHosts(s.cfg.SSHKnownHostsPath)
	if err != nil || len(entries) == 0 {
		// The append above succeeded; a failure to re-read/re-parse it back
		// is surprising but not fatal to the write itself.
		writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
		return
	}
	writeJSON(w, http.StatusCreated, entries[len(entries)-1])
}

func (s *Server) handleDeleteKnownHost(w http.ResponseWriter, r *http.Request) {
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid index")
		return
	}

	if err := gitconfig.DeleteKnownHost(s.cfg.SSHKnownHostsPath, index); err != nil {
		if errors.Is(err, gitconfig.ErrKnownHostNotFound) {
			writeError(w, http.StatusNotFound, "known_hosts entry not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
