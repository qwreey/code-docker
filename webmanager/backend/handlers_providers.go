package main

import "net/http"

// handleListProviders returns the provider pages declared through
// WEBMANAGER_PROVIDER_* as [{"id","title"}], [] when none are configured.
// See internal/providers.
func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.providers.List())
}
