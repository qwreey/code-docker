package main

import (
	"encoding/json"
	"errors"
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

// FontRecommendation is one entry in a font category's list — source fields
// (directURL/zipURL/...) deliberately aren't part of the wire shape, only
// what the frontend needs to display + POST /api/fonts/install {id} against.
type FontRecommendation struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Weight      int    `json:"weight"`
	Style       string `json:"style"`
}

type FontRecommendationCategory struct {
	Category string               `json:"category"`
	Fonts    []FontRecommendation `json:"fonts"`
}

type RecommendationsResponse struct {
	Extensions []RecommendedExtension       `json:"extensions"`
	Mise       []MiseRecommendationCategory `json:"mise,omitempty"`
	Fonts      []FontRecommendationCategory `json:"fonts,omitempty"`
}

type CodeExtensionsResponse struct {
	Installed []string `json:"installed"`
}

// VSIXFallback describes, for the consent prompt, the direct marketplace
// download offered when an extension isn't on open-vsx.
type VSIXFallback struct {
	Host     string `json:"host"`
	MaxBytes int64  `json:"maxBytes"`
}

type LookupExtensionResponse struct {
	Matched      bool                    `json:"matched"`
	Source       string                  `json:"source,omitempty"`
	ID           string                  `json:"id,omitempty"`
	OpenVSX      *extensions.OpenVSXInfo `json:"openVsx,omitempty"`
	VSIXFallback *VSIXFallback           `json:"vsixFallback,omitempty"`
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
		Fonts:      make([]FontRecommendationCategory, 0, len(recs.Fonts)),
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
	for _, c := range recs.Fonts {
		items := make([]FontRecommendation, 0, len(c.Fonts))
		for _, f := range c.Fonts {
			items = append(items, FontRecommendation{ID: f.ID, Label: f.Label, Description: f.Description, Weight: f.Weight, Style: f.Style})
		}
		resp.Fonts = append(resp.Fonts, FontRecommendationCategory{Category: c.Category, Fonts: items})
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
	s.markRestartDirty()

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
	s.markRestartDirty()

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleLookupCodeExtension turns pasted text into an extension id and asks
// open-vsx whether it can be installed the normal way. Read-only: it fetches
// from two fixed hosts with a validated id, nothing user-controlled reaches
// a URL host or an exec.
func (s *Server) handleLookupCodeExtension(w http.ResponseWriter, r *http.Request) {
	parsed, err := extensions.ParseInput(r.URL.Query().Get("text"))
	switch {
	case errors.Is(err, extensions.ErrNoExtension):
		writeJSON(w, http.StatusOK, LookupExtensionResponse{Matched: false})
		return
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	info, err := s.extSources.LookupOpenVSX(r.Context(), parsed.ID)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	resp := LookupExtensionResponse{Matched: true, Source: parsed.Source, ID: parsed.ID, OpenVSX: &info}
	if !info.Found {
		resp.VSIXFallback = &VSIXFallback{Host: extensions.MarketplaceHost(), MaxBytes: extensions.MaxVSIXBytes}
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleInstallCodeExtensionVSIX is the fallback for an extension that isn't
// on open-vsx: the frontend calls it only after the user has agreed to a
// direct MS Marketplace download.
func (s *Server) handleInstallCodeExtensionVSIX(w http.ResponseWriter, r *http.Request) {
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

	if err := s.extSources.InstallFromMarketplaceVSIX(r.Context(), s.cfg.CodeServerBinPath, s.cfg.CodeServerUserDataDir, s.cfg.CodeServerExtensionsDir, body.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.markRestartDirty()

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
