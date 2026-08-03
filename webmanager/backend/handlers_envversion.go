package main

import (
	"net/http"

	"webmanager/internal/envversionprefs"
)

// handleEnvVersion backs the startup env-version-mismatch banner (see
// webmanager/.claude/env-migration-plan.md) — read-only, no gate, same as
// every other purely-informational endpoint. currentVersion/mismatch are
// fixed for the process lifetime (computed once in main() from
// cfg.EnvTemplatePath); only the dismissed flag is looked up per-request.
func (s *Server) handleEnvVersion(w http.ResponseWriter, r *http.Request) {
	dismiss, err := envversionprefs.Load(s.cfg.EnvVersionDismissPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	current := s.envTemplateVersion
	file := s.cfg.EnvVersion
	mismatch := current != "" && current != file
	dismissed := mismatch && dismiss.DismissedVersion == current

	writeJSON(w, http.StatusOK, map[string]any{
		"currentVersion": current,
		"fileVersion":    file,
		"mismatch":       mismatch,
		"dismissed":      dismissed,
	})
}

// handleDismissEnvVersion records that the user has acknowledged the
// currently-running image's env-version warning. Dismissal is keyed to
// s.envTemplateVersion (the image's version), not the file's — so a later
// image upgrade that bumps the template version automatically re-arms the
// banner even though this dismissal record still exists.
func (s *Server) handleDismissEnvVersion(w http.ResponseWriter, r *http.Request) {
	if s.envTemplateVersion == "" {
		writeError(w, http.StatusBadRequest, "no current env template version to dismiss")
		return
	}
	if err := envversionprefs.Save(s.cfg.EnvVersionDismissPath, envversionprefs.Dismiss{DismissedVersion: s.envTemplateVersion}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
