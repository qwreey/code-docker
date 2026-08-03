package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/terminalprofiles"
)

// handleGetTerminalProfiles returns the persisted Home-tab launch profiles.
// Gated like everything else terminal-related — see handleGetTerminalSettings.
func (s *Server) handleGetTerminalProfiles(w http.ResponseWriter, r *http.Request) {
	doc, err := terminalprofiles.Load(s.cfg.TerminalProfilesPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// handlePutTerminalProfiles replaces the whole profiles document, same
// no-partial-merge contract as handlePutTerminalSettings. Every profile must
// have a non-empty id (frontend-generated) and label; Cwd/Command are
// free-form and validated only loosely (see termsession.newSession, which
// falls back to its default cwd rather than failing on a bad path, and
// treats InitialCommand as literal keystrokes into an already-full-access
// shell — no injection surface beyond what typing it yourself would be).
func (s *Server) handlePutTerminalProfiles(w http.ResponseWriter, r *http.Request) {
	var body terminalprofiles.Document
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Profiles == nil {
		body.Profiles = []terminalprofiles.Profile{}
	}
	for _, p := range body.Profiles {
		if p.ID == "" || p.Label == "" {
			writeError(w, http.StatusBadRequest, "every profile needs an id and a label")
			return
		}
	}

	if err := terminalprofiles.Save(s.cfg.TerminalProfilesPath, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}
