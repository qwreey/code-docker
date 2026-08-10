package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

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

// cloneProjectRequest is POST /api/projects/clone's body. Root may be
// omitted when only one scan root is configured (the common case) — the
// frontend only shows a root picker when GET /api/projects's Roots has more
// than one entry. Branch may be omitted to clone the remote's default
// branch. Recursive adds --recursive (submodules). Depth, if positive, adds
// --depth <n> (a shallow clone) — 0 (or omitted) means a full clone.
type cloneProjectRequest struct {
	URL       string `json:"url"`
	Name      string `json:"name"`
	Root      string `json:"root"`
	Branch    string `json:"branch"`
	Recursive bool   `json:"recursive"`
	Depth     int    `json:"depth"`
}

// handleCloneProject runs `git clone` into a fresh subdirectory of an
// already-known scan root, as a background job (s.projectJobs — a separate
// *mise.JobStore instance from s.miseJobs, see server.go's doc comment) so a
// slow network clone doesn't block the HTTP response. Root/Name are
// validated by internal/projects.Scanner.PrepareClone (exact-match against
// configured roots, strict charset for Name — see that function's doc
// comment) and Branch by internal/projects.ValidateBranchName before any of
// them ever reaches exec.Command; URL and the resolved dest are passed as
// their own exec.Command arguments after a "--" separator (never string-
// concatenated), the same defense-in-depth convention
// internal/projectgit.RemoveWorktree uses, so neither can be misparsed as a
// git flag regardless of its content. Gated like every other project
// mutation (handleDeleteProject etc.) — this creates a new directory and
// makes a real network connection.
func (s *Server) handleCloneProject(w http.ResponseWriter, r *http.Request) {
	var body cloneProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	body.URL = strings.TrimSpace(body.URL)
	if body.URL == "" {
		writeError(w, http.StatusBadRequest, "url is required")
		return
	}
	if strings.ContainsAny(body.URL, "\r\n\x00") {
		writeError(w, http.StatusBadRequest, "invalid url")
		return
	}

	body.Branch = strings.TrimSpace(body.Branch)
	if body.Branch != "" {
		if err := projects.ValidateBranchName(body.Branch); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if body.Depth < 0 {
		writeError(w, http.StatusBadRequest, "depth must not be negative")
		return
	}

	root := body.Root
	if root == "" {
		defaultRoot, ok := s.projectScanner.DefaultRoot()
		if !ok {
			writeError(w, http.StatusBadRequest, "no project root configured")
			return
		}
		root = defaultRoot
	}

	dest, err := s.projectScanner.PrepareClone(root, body.Name)
	switch {
	case errors.Is(err, projects.ErrUnknownRoot):
		writeError(w, http.StatusBadRequest, "unknown project root")
		return
	case errors.Is(err, projects.ErrInvalidCloneName):
		writeError(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, projects.ErrCloneDestExists):
		writeError(w, http.StatusConflict, "a project with this name already exists")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	args := []string{"clone", "--progress"}
	if body.Branch != "" {
		args = append(args, "-b", body.Branch)
	}
	if body.Recursive {
		args = append(args, "--recursive")
	}
	if body.Depth > 0 {
		args = append(args, "--depth", strconv.Itoa(body.Depth))
	}
	args = append(args, "--", body.URL, dest)

	jobID := s.projectJobs.StartWithCallback(func(exitCode int) {
		if exitCode == 0 {
			s.projectScanner.TriggerScan()
		}
	}, "git", args)
	writeJSON(w, http.StatusOK, jobResponse{JobID: jobID})
}

// handleProjectJobStatus reports progress for a job started by
// handleCloneProject — a plain read (s.projectJobs.Status doesn't mutate
// anything), so unlike the clone-start route this is ungated, same
// convention as GET /api/mise/jobs/{id}.
func (s *Server) handleProjectJobStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	status, ok := s.projectJobs.Status(id)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown job id")
		return
	}
	writeJSON(w, http.StatusOK, status)
}
