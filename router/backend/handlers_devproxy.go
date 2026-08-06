// Moved here from webmanager/backend/handlers_devproxy.go (see
// router/backend/internal/devproxy/devproxy.go's own package comment for
// the full migration context). No host port is published for router-manager
// yet (see main.go) - these endpoints are private-by-default the same way
// GET /api/tailscale/state is, matching Phase 2's precedent. Router's own
// admin-auth story (gating router-manager's API itself, not just individual
// exposed dev-server routes) is future work once router gets a real UI.
package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"router/internal/devproxy"
)

func handleListDevProxyExposes(w http.ResponseWriter, r *http.Request) {
	list, err := devproxy.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func handleCreateDevProxyExpose(w http.ResponseWriter, r *http.Request) {
	var body devproxy.Expose
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := devproxy.Create(r.Context(), body); err != nil {
		writeDevProxyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleUpdateDevProxyExpose(w http.ResponseWriter, r *http.Request) {
	oldName := r.PathValue("name")
	var body struct {
		Raw    *string          `json:"raw,omitempty"`
		Name   string           `json:"name,omitempty"` // present + different from oldName = rename
		Host   string           `json:"host"`
		Routes []devproxy.Route `json:"routes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var err error
	if body.Raw != nil {
		err = devproxy.UpdateRaw(r.Context(), oldName, *body.Raw)
	} else {
		newName := body.Name
		if newName == "" {
			newName = oldName
		}
		err = devproxy.UpdateStructured(r.Context(), oldName, devproxy.Expose{
			Name:   newName,
			Host:   body.Host,
			Routes: body.Routes,
		})
	}
	if err != nil {
		writeDevProxyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleDeleteDevProxyExpose(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := devproxy.Delete(r.Context(), name); err != nil {
		writeDevProxyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleReloadDevProxy(w http.ResponseWriter, r *http.Request) {
	if err := devproxy.Reload(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeDevProxyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, devproxy.ErrExposeExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, devproxy.ErrExposeNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}
