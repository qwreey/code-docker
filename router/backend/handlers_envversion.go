package main

import (
	"net/http"

	"router/internal/envversionprefs"
)

// handleEnvVersion backs router/frontend's env-version-mismatch banner -
// mirrors webmanager/backend/handlers_envversion.go exactly. Read-only, no
// gate, same as every other purely-informational endpoint.
// envTemplateVersion/envVersion are fixed for the process lifetime
// (computed once in main() from ROUTER_ENV_TEMPLATE_PATH/ROUTER_ENV_VERSION,
// same values the startup log warning already uses); only the dismissed
// flag is looked up per-request.
func handleEnvVersion(w http.ResponseWriter, r *http.Request) {
	dismiss, err := envversionprefs.Load(envVersionDismissPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	mismatch := envTemplateVersion != "" && envTemplateVersion != envVersion
	dismissed := mismatch && dismiss.DismissedVersion == envTemplateVersion

	writeJSON(w, http.StatusOK, map[string]any{
		"currentVersion": envTemplateVersion,
		"fileVersion":    envVersion,
		"mismatch":       mismatch,
		"dismissed":      dismissed,
	})
}

// handleDismissEnvVersion records that the user has acknowledged the
// currently-running image's env-version warning. Dismissal is keyed to
// envTemplateVersion (the image's version), not the file's - so a later
// image upgrade that bumps the template version automatically re-arms the
// banner even though this dismissal record still exists.
func handleDismissEnvVersion(w http.ResponseWriter, r *http.Request) {
	if envTemplateVersion == "" {
		writeError(w, http.StatusBadRequest, "no current env template version to dismiss")
		return
	}
	if err := envversionprefs.Save(envVersionDismissPath, envversionprefs.Dismiss{DismissedVersion: envTemplateVersion}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
