package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"webmanager/internal/browsernames"
)

// browserNameMaxLen bounds a user-typed friendly name — generous enough for
// "형진이 노트북" style labels, tight enough to keep the persisted file small.
const browserNameMaxLen = 60

// handleListBrowserNames returns every persisted browserId->name mapping.
// Gated like GET /api/sessions itself — the Sessions tab is the only
// consumer, and browser names are only meaningful alongside that list.
func (s *Server) handleListBrowserNames(w http.ResponseWriter, r *http.Request) {
	names, err := browsernames.Load(s.cfg.BrowserNamesPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, names)
}

type setBrowserNameRequest struct {
	Name string `json:"name"`
}

// handleSetBrowserName assigns (or, given an empty/whitespace-only name,
// clears) the friendly name for one browserId. Read-modify-write with no
// cross-request lock — acceptable here since this is a rarely-written,
// single-operator-editing document, same tradeoff sidebar-order.json and
// terminal-settings.json already make.
func (s *Server) handleSetBrowserName(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "id must be a UUID")
		return
	}

	var body setBrowserNameRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > browserNameMaxLen {
		writeError(w, http.StatusBadRequest, "name is too long")
		return
	}

	names, err := browsernames.Load(s.cfg.BrowserNamesPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if name == "" {
		delete(names, id)
	} else {
		names[id] = name
	}
	if err := browsernames.Save(s.cfg.BrowserNamesPath, names); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, names)
}
