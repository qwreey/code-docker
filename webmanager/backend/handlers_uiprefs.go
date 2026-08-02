package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/uiprefs"
)

func (s *Server) handleGetSidebarOrder(w http.ResponseWriter, r *http.Request) {
	order, err := uiprefs.LoadSidebarOrder(s.cfg.SidebarOrderPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func (s *Server) handlePutSidebarOrder(w http.ResponseWriter, r *http.Request) {
	var body uiprefs.SidebarOrder
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := uiprefs.SaveSidebarOrder(s.cfg.SidebarOrderPath, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
