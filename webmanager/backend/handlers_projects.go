package main

import (
	"errors"
	"net/http"

	"webmanager/internal/projects"
)

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	resp := s.projectScanner.Snapshot()
	if resp.ScannedAt == nil {
		s.projectScanner.TriggerScan()
		resp = s.projectScanner.Snapshot()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleScanProjects(w http.ResponseWriter, r *http.Request) {
	s.projectScanner.TriggerScan()
	writeJSON(w, http.StatusOK, s.projectScanner.Snapshot())
}

func (s *Server) handleRescanProject(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}

	info, err := s.projectScanner.RescanOne(path)
	switch {
	case errors.Is(err, projects.ErrUnknownProject):
		writeError(w, http.StatusBadRequest, "unknown project path")
	case errors.Is(err, projects.ErrProjectGone):
		writeError(w, http.StatusNotFound, "project no longer exists")
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, info)
	}
}
