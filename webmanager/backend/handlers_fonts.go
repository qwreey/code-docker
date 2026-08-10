package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"webmanager/internal/fonts"
)

// handleListFonts returns the full font manifest. Ungated — font metadata
// isn't sensitive, and it's a normal read like every other listing route.
func (s *Server) handleListFonts(w http.ResponseWriter, r *http.Request) {
	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// handleFontsCSS serves the generated @font-face stylesheet. Deliberately
// ungated and unauthenticated by design, not just by omission — code-server's
// own page loads this via config/code/code-patch/fonts.default.css's
// @import with no session/cookie of its own to attach, and webmanager's own
// index.html links it unconditionally too (see frontend index.html).
func (s *Server) handleFontsCSS(w http.ResponseWriter, r *http.Request) {
	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	// Deliberately not cached long — this response changes whenever a font
	// is uploaded/edited/deleted, and unlike the /files/{id} route below
	// there's no content-addressed id in this URL to bust a stale cache
	// with.
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(fonts.GenerateCSS(m.Fonts)))
}

// handleFontFile serves one font's raw binary content. Ungated for the same
// reason handleFontsCSS is — it's what that generated CSS's url() points at.
func (s *Server) handleFontFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, f := range m.Fonts {
		if f.ID != id {
			continue
		}
		w.Header().Set("Content-Type", fonts.MIME(f.Ext))
		// f.ID is a random id minted once at upload time and never reused
		// for different content (metadata-only edits via PATCH don't touch
		// the file) — safe to cache as immutable.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, fonts.StoredPath(s.cfg.FontsDir, f))
		return
	}
	writeError(w, http.StatusNotFound, "font not found")
}

// handleUploadFont accepts one font file per request via multipart/form-data
// ("file" part, plus optional "family"/"weight"/"style" fields) — fonts are
// small (KB-few MB), so a plain ParseMultipartForm is fine here, unlike the
// Files tab's streaming upload built for gigabyte-scale transfers.
func (s *Server) handleUploadFont(w http.ResponseWriter, r *http.Request) {
	maxUpload, err := strconv.ParseInt(s.cfg.FontsMaxUploadBytes, 10, 64)
	if err != nil || maxUpload <= 0 {
		maxUpload = 10 * 1024 * 1024
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)

	if err := r.ParseMultipartForm(maxUpload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart request or file too large")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(header.Filename), "."))
	if !fonts.AllowedExt(ext) {
		writeError(w, http.StatusBadRequest, "unsupported font file type: "+ext)
		return
	}

	family := strings.TrimSpace(r.FormValue("family"))
	if family == "" {
		family = strings.TrimSuffix(filepath.Base(header.Filename), filepath.Ext(header.Filename))
	}
	weight, werr := strconv.Atoi(r.FormValue("weight"))
	if werr != nil || weight < 100 || weight > 900 {
		weight = 400
	}
	style := strings.TrimSpace(r.FormValue("style"))
	if style != "italic" && style != "oblique" {
		style = "normal"
	}

	id, err := fonts.RandomID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "id generation failed")
		return
	}

	f := fonts.Font{
		ID:               id,
		Family:           family,
		Weight:           weight,
		Style:            style,
		Format:           fonts.FormatForExt(ext),
		Ext:              ext,
		OriginalFilename: header.Filename,
	}

	if err := fonts.SaveFile(s.cfg.FontsDir, f, file); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	m.Fonts = append(m.Fonts, f)
	if err := fonts.Save(s.cfg.FontsDir, m); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, f)
}

// handlePatchFont updates just family/weight/style for an existing font —
// the file itself is immutable once uploaded (see handleFontFile's caching
// comment); replacing content means delete + re-upload.
func (s *Server) handlePatchFont(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Family string `json:"family"`
		Weight int    `json:"weight"`
		Style  string `json:"style"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	found := false
	for i := range m.Fonts {
		if m.Fonts[i].ID != id {
			continue
		}
		if family := strings.TrimSpace(body.Family); family != "" {
			m.Fonts[i].Family = family
		}
		if body.Weight >= 100 && body.Weight <= 900 {
			m.Fonts[i].Weight = body.Weight
		}
		if body.Style == "normal" || body.Style == "italic" || body.Style == "oblique" {
			m.Fonts[i].Style = body.Style
		}
		found = true
		break
	}
	if !found {
		writeError(w, http.StatusNotFound, "font not found")
		return
	}

	if err := fonts.Save(s.cfg.FontsDir, m); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// handleDeleteFont removes a font's manifest entry and its stored file.
func (s *Server) handleDeleteFont(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	m, err := fonts.Load(s.cfg.FontsDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	idx := -1
	for i, f := range m.Fonts {
		if f.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "font not found")
		return
	}

	target := m.Fonts[idx]
	m.Fonts = append(m.Fonts[:idx], m.Fonts[idx+1:]...)
	if err := fonts.Save(s.cfg.FontsDir, m); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = fonts.DeleteFile(s.cfg.FontsDir, target)

	writeJSON(w, http.StatusOK, m)
}
