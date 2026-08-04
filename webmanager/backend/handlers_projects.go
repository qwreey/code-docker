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

// handleDeleteReclaimable deletes one reclaimable subtree (node_modules,
// target, ...) from disk — never the project directory itself, that's out
// of scope. Both path (the project) and target (the reclaimable entry) must
// exactly match the scan cache, validated by
// internal/projects.Scanner.DeleteReclaimable using the same exact-match
// convention as handleRescanProject above. Gated by s.gate in main.go since
// this is a destructive write, unlike the read-only project endpoints.
func (s *Server) handleDeleteReclaimable(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	target := r.URL.Query().Get("target")
	if path == "" || target == "" {
		writeError(w, http.StatusBadRequest, "path and target are required")
		return
	}

	info, err := s.projectScanner.DeleteReclaimable(path, target)
	switch {
	case errors.Is(err, projects.ErrUnknownProject):
		writeError(w, http.StatusBadRequest, "unknown project path")
	case errors.Is(err, projects.ErrUnknownReclaimable):
		writeError(w, http.StatusBadRequest, "unknown reclaimable path")
	case errors.Is(err, projects.ErrProjectGone):
		writeError(w, http.StatusNotFound, "project no longer exists")
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, info)
	}
}

// handleDeleteProject permanently deletes an entire project's directory from
// disk — distinct from handleDeleteReclaimable above, which only ever
// touches a reclaimable subtree within a project. path must exactly match an
// existing cached project's Path, validated by
// internal/projects.Scanner.DeleteProject using the same exact-match
// convention as every other project mutation endpoint (never a
// prefix/contains check). Gated by s.gate in main.go since this is a
// destructive write.
func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}

	err := s.projectScanner.DeleteProject(path)
	switch {
	case errors.Is(err, projects.ErrUnknownProject):
		writeError(w, http.StatusBadRequest, "unknown project path")
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
