package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/gitconfig"
)

func (s *Server) handleGetGitAITrailer(w http.ResponseWriter, r *http.Request) {
	t, err := gitconfig.GetAITrailer(s.cfg.GitConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handlePutGitAITrailer(w http.ResponseWriter, r *http.Request) {
	var body gitconfig.AITrailer
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := gitconfig.SetAITrailer(s.cfg.GitConfigPath, body); err != nil {
		if errors.Is(err, gitconfig.ErrInvalidTrailerIdentity) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Re-read rather than echoing the request: HookActive is read-only and
	// the fallback/normalization rules live in the getter.
	t, err := gitconfig.GetAITrailer(s.cfg.GitConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}
