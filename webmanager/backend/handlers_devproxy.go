package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/devproxy"
)

func (s *Server) handleListDevProxyExposes(w http.ResponseWriter, r *http.Request) {
	list, err := devproxy.List(s.cfg.Addr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateDevProxyExpose(w http.ResponseWriter, r *http.Request) {
	var body devproxy.Expose
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := devproxy.Create(r.Context(), s.cfg.Addr, body); err != nil {
		writeDevProxyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleUpdateDevProxyExpose(w http.ResponseWriter, r *http.Request) {
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
		err = devproxy.UpdateStructured(r.Context(), s.cfg.Addr, oldName, devproxy.Expose{
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

func (s *Server) handleDeleteDevProxyExpose(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := devproxy.Delete(r.Context(), name); err != nil {
		writeDevProxyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleReloadDevProxy(w http.ResponseWriter, r *http.Request) {
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
