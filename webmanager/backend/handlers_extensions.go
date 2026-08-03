package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/extensions"
)

type RecommendedExtension struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Category    string `json:"category"`
}

type MiseRecommendedTool struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type MiseRecommendationCategory struct {
	Category string                `json:"category"`
	Tools    []MiseRecommendedTool `json:"tools"`
}

type RecommendationsResponse struct {
	Extensions []RecommendedExtension       `json:"extensions"`
	Mise       []MiseRecommendationCategory `json:"mise,omitempty"`
}

type CodeExtensionsResponse struct {
	Installed []string `json:"installed"`
}

func (s *Server) handleGetRecommendations(w http.ResponseWriter, r *http.Request) {
	recs, err := extensions.LoadRecommendations(s.cfg.RecommendationsDefaultPath, s.cfg.RecommendationsOverridePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	resp := RecommendationsResponse{
		Extensions: make([]RecommendedExtension, 0, len(recs.Extensions)),
		Mise:       make([]MiseRecommendationCategory, 0, len(recs.Mise)),
	}
	for _, e := range recs.Extensions {
		resp.Extensions = append(resp.Extensions, RecommendedExtension{
			ID:          e.ID,
			Label:       e.Label,
			Description: e.Description,
			Category:    e.Category,
		})
	}
	for _, c := range recs.Mise {
		tools := make([]MiseRecommendedTool, 0, len(c.Tools))
		for _, t := range c.Tools {
			tools = append(tools, MiseRecommendedTool{ID: t.ID, Label: t.Label, Description: t.Description})
		}
		resp.Mise = append(resp.Mise, MiseRecommendationCategory{Category: c.Category, Tools: tools})
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleListCodeExtensions(w http.ResponseWriter, r *http.Request) {
	installed, err := extensions.ListInstalled(r.Context(), s.cfg.CodeServerBinPath, s.cfg.CodeServerUserDataDir, s.cfg.CodeServerExtensionsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, CodeExtensionsResponse{Installed: installed})
}

func (s *Server) handleInstallCodeExtension(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := extensions.ValidateID(body.ID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := extensions.Install(r.Context(), s.cfg.CodeServerBinPath, s.cfg.CodeServerUserDataDir, s.cfg.CodeServerExtensionsDir, body.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleUninstallCodeExtension(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := extensions.ValidateID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := extensions.Uninstall(r.Context(), s.cfg.CodeServerBinPath, s.cfg.CodeServerUserDataDir, s.cfg.CodeServerExtensionsDir, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
