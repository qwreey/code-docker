package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/mise"
)

// miseToolsResponse is GET /api/mise/tools's body. Tools is never nil.
type miseToolsResponse struct {
	Tools []mise.Tool `json:"tools"`
}

// handleListMiseTools reports installed/declared mise tools: every install
// mise knows about at $HOME (`mise ls --json`, both global-config-declared
// and bare-`mise install`ed) when path is omitted, or one project's own
// mise.toml/.tool-versions (`mise ls -C <path> --local --json`) when given.
// path must exactly match an entry already in the Projects cache — the same
// convention handleRescanProject uses — so this can never shell out against
// an arbitrary filesystem path. mise not being installed degrades to an
// empty list, matching handleClaudeStatus/handleClaudePlugins's convention
// that "not installed" is a normal state, not an HTTP error.
func (s *Server) handleListMiseTools(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path != "" && !s.projectScanner.IsKnownPath(path) {
		writeError(w, http.StatusBadRequest, "unknown project path")
		return
	}

	binPath, ok := mise.FindBinary(s.cfg.MiseBinPath)
	if !ok {
		writeJSON(w, http.StatusOK, miseToolsResponse{Tools: []mise.Tool{}})
		return
	}

	var tools []mise.Tool
	var err error
	if path == "" {
		tools, err = mise.ListInstalledTools(r.Context(), binPath)
	} else {
		tools, err = mise.ListTools(r.Context(), binPath, path)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, miseToolsResponse{Tools: tools})
}

// miseToolRequest is POST /api/mise/tools's body.
type miseToolRequest struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Global  bool   `json:"global"`
	Path    string `json:"path"`
}

// jobResponse is both POST and DELETE /api/mise/tools's body: the
// background job's id, for the frontend to poll via
// GET /api/mise/jobs/:id.
type jobResponse struct {
	JobID string `json:"jobId"`
}

// handleCreateMiseTool installs a tool and records it in mise's config in
// one step (`mise use -y <id>@<version>`, global or project-scoped) as a
// background job — mise-plan.md's API design deliberately skips a separate
// "install without recording in config" endpoint for v1. Runs in the
// background; the response is just the new job's id, not completion.
func (s *Server) handleCreateMiseTool(w http.ResponseWriter, r *http.Request) {
	var body miseToolRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := mise.ValidateToolID(body.ID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := mise.ValidateVersion(body.Version); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !body.Global {
		if body.Path == "" || !s.projectScanner.IsKnownPath(body.Path) {
			writeError(w, http.StatusBadRequest, "unknown project path")
			return
		}
	}

	binPath, ok := mise.FindBinary(s.cfg.MiseBinPath)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "mise is not installed")
		return
	}

	spec := body.ID + "@" + body.Version
	var args []string
	if body.Global {
		args = []string{"use", "-g", "-y", spec}
	} else {
		args = []string{"use", "-C", body.Path, "-y", spec}
	}

	jobID := s.miseJobs.StartWithCallback(s.onMiseJobDone, binPath, args)
	writeJSON(w, http.StatusOK, jobResponse{JobID: jobID})
}

// miseDeleteRequest is DELETE /api/mise/tools's body. RemoveFromConfig
// defaults to false (plain `mise uninstall`, which only removes the
// installed version — mise.toml's [tools] entry survives, so a later
// `mise install` re-fetches it) when omitted; true also runs
// `mise use --remove <id>` afterward to drop the config entry itself.
type miseDeleteRequest struct {
	ID               string `json:"id"`
	Version          string `json:"version"`
	Global           bool   `json:"global"`
	Path             string `json:"path"`
	RemoveFromConfig bool   `json:"removeFromConfig"`
}

// handleDeleteMiseTool uninstalls a tool version, optionally also removing
// its entry from mise's config, as a background job (see miseDeleteRequest).
func (s *Server) handleDeleteMiseTool(w http.ResponseWriter, r *http.Request) {
	var body miseDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := mise.ValidateToolID(body.ID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := mise.ValidateVersion(body.Version); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !body.Global {
		if body.Path == "" || !s.projectScanner.IsKnownPath(body.Path) {
			writeError(w, http.StatusBadRequest, "unknown project path")
			return
		}
	}

	binPath, ok := mise.FindBinary(s.cfg.MiseBinPath)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "mise is not installed")
		return
	}

	spec := body.ID + "@" + body.Version
	argSets := [][]string{{"uninstall", spec}}
	if body.RemoveFromConfig {
		removeArgs := []string{"use"}
		if body.Global {
			removeArgs = append(removeArgs, "-g")
		} else {
			removeArgs = append(removeArgs, "-C", body.Path)
		}
		removeArgs = append(removeArgs, "--remove", body.ID)
		argSets = append(argSets, removeArgs)
	}

	jobID := s.miseJobs.StartWithCallback(s.onMiseJobDone, binPath, argSets...)
	writeJSON(w, http.StatusOK, jobResponse{JobID: jobID})
}

// miseEnvResponse is GET /api/mise/env's body.
type miseEnvResponse struct {
	Env map[string]string `json:"env"`
}

// handleMiseEnv reports `mise env --json` for path (global/$HOME when
// omitted) — same path-validation convention as handleListMiseTools. Values
// can include sensitive-looking data (API keys some tool's env config sets,
// etc.) — exposed as-is under webmanager's existing trust model (no login of
// its own, relies on the fronting reverse proxy), matching mise-plan.md's
// explicit decision to skip masking for v1.
func (s *Server) handleMiseEnv(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path != "" && !s.projectScanner.IsKnownPath(path) {
		writeError(w, http.StatusBadRequest, "unknown project path")
		return
	}

	binPath, ok := mise.FindBinary(s.cfg.MiseBinPath)
	if !ok {
		writeJSON(w, http.StatusOK, miseEnvResponse{Env: map[string]string{}})
		return
	}

	env, err := mise.GetEnv(r.Context(), binPath, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, miseEnvResponse{Env: env})
}

// handleMiseJobStatus reports a background mise job's accumulated progress
// — the frontend polls this every 0.5-1s while a job is running, per
// mise-plan.md's polling design (Projects tab's `scanning: true` polling is
// the precedent this mirrors).
func (s *Server) handleMiseJobStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	status, ok := s.miseJobs.Status(id)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown job id")
		return
	}
	writeJSON(w, http.StatusOK, status)
}
