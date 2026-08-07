// App Routes' HTTP layer - mirrors handlers_devproxy.go almost line for
// line (see that file's own doc comment for the shared conventions: private
// by default, gate.RequirePassword on every mutating route, reads open).
package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"router/internal/approutes"
)

func handleListAppRoutes(w http.ResponseWriter, r *http.Request) {
	list, err := approutes.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func handleCreateAppRoute(w http.ResponseWriter, r *http.Request) {
	var body approutes.App
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := approutes.Create(r.Context(), body); err != nil {
		writeAppRouteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleUpdateAppRoute(w http.ResponseWriter, r *http.Request) {
	oldName := r.PathValue("name")
	var body struct {
		Raw         *string `json:"raw,omitempty"`
		Name        string  `json:"name,omitempty"` // present + different from oldName = rename
		Target      string  `json:"target"`
		RequireAuth bool    `json:"requireAuth"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var err error
	if body.Raw != nil {
		err = approutes.UpdateRaw(r.Context(), oldName, *body.Raw)
	} else {
		newName := body.Name
		if newName == "" {
			newName = oldName
		}
		err = approutes.UpdateStructured(r.Context(), oldName, approutes.App{
			Name:        newName,
			Target:      body.Target,
			RequireAuth: body.RequireAuth,
		})
	}
	if err != nil {
		writeAppRouteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleDeleteAppRoute(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := approutes.Delete(r.Context(), name); err != nil {
		writeAppRouteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleReloadAppRoutes(w http.ResponseWriter, r *http.Request) {
	if err := approutes.Reload(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeAppRouteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, approutes.ErrAppExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, approutes.ErrAppNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}
