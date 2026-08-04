// Git status/history for one project — read-only for now (staging,
// committing, pushing, pulling, and merge tooling are all explicitly out of
// scope, deferred to a future milestone). Every handler here takes a `path`
// query param that must exactly match an already-known project path from
// s.projectScanner (see internal/projects.Scanner.IsKnownPath's doc comment
// for why exact-match, never prefix/contains) before any git/os-exec call
// touches it — same convention as handlers_projects.go's mutation handlers,
// reused rather than re-derived. None of these are wrapped in
// gate.RequirePassword: they're all reads, and this app's convention is
// reads-stay-open/writes-gated (see webmanager/CLAUDE.md).
package main

import (
	"errors"
	"net/http"
	"strconv"

	"webmanager/internal/projectgit"
)

// projectGitPath validates the `path` query param against the project
// scanner's cache, writing a 400 and returning ok=false if it's missing or
// doesn't exactly match a known project.
func (s *Server) projectGitPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return "", false
	}
	if !s.projectScanner.IsKnownPath(path) {
		writeError(w, http.StatusBadRequest, "unknown project path")
		return "", false
	}
	return path, true
}

// writeProjectGitErr maps projectgit's sentinel errors to the right HTTP
// status; anything else (a real git failure, e.g. corrupt repo) is a 502
// since it's an upstream (git) failure, not a caller mistake.
func writeProjectGitErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, projectgit.ErrNotGitRepo):
		writeError(w, http.StatusBadRequest, "not a git repository")
	case errors.Is(err, projectgit.ErrInvalidHash):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// handleProjectGitStatus never errors on "not a repo" — it reports
// {"isGitRepo": false} instead, so the frontend can hide the git panel
// gracefully rather than handling an error response (see projectgit.Status's
// doc comment).
func (s *Server) handleProjectGitStatus(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	st, err := projectgit.Status(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleProjectGitLog(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = n
	}
	cursor := r.URL.Query().Get("cursor")

	page, err := projectgit.Log(path, limit, cursor)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) handleProjectGitDiffCommit(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeError(w, http.StatusBadRequest, "hash is required")
		return
	}
	text, err := projectgit.CommitDiff(path, hash)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (s *Server) handleProjectGitDiffUnstaged(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	text, err := projectgit.UnstagedDiff(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (s *Server) handleProjectGitDiffStaged(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	text, err := projectgit.StagedDiff(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (s *Server) handleProjectGitRemotes(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	remotes, err := projectgit.Remotes(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, remotes)
}

func (s *Server) handleProjectGitBranches(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	branches, err := projectgit.Branches(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

func (s *Server) handleProjectGitTags(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	tags, err := projectgit.Tags(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tags)
}
