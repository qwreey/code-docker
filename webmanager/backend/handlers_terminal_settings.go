package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/terminalsettings"
)

// handleGetTerminalSettings returns the persisted keybindings/theme blob.
// Gated like GET /api/terminal itself — everything about the terminal
// feature is treated as sensitive, reads included.
func (s *Server) handleGetTerminalSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := terminalsettings.Load(s.cfg.TerminalSettingsPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// handlePutTerminalSettings replaces the whole settings document. No
// partial-update merge logic — the frontend always sends the full shape,
// and json.Decode already rejects anything that isn't well-formed JSON
// matching it.
func (s *Server) handlePutTerminalSettings(w http.ResponseWriter, r *http.Request) {
	var body terminalsettings.Settings
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Keybindings == nil {
		body.Keybindings = []terminalsettings.KeyBinding{}
	}
	if body.CustomThemes == nil {
		body.CustomThemes = []terminalsettings.TerminalTheme{}
	}

	if err := terminalsettings.Save(s.cfg.TerminalSettingsPath, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}
