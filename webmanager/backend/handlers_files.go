package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"webmanager/internal/files"
)

// writeFilesError maps internal/files errors to HTTP status codes. Falls
// through to os.ErrNotExist/os.ErrPermission (errors.Is works transitively
// through *fs.PathError from the stdlib os calls inside internal/files) for
// anything internal/files didn't wrap in one of its own sentinels.
func writeFilesError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, files.ErrInvalidPath),
		errors.Is(err, files.ErrRootPath),
		errors.Is(err, files.ErrInvalidName),
		errors.Is(err, files.ErrNotDir),
		errors.Is(err, files.ErrIsDir),
		errors.Is(err, files.ErrBinaryFile),
		errors.Is(err, files.ErrFileTooLarge):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, os.ErrPermission):
		writeError(w, http.StatusForbidden, "permission denied")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = s.cfg.FilesRoot
	}
	entries, err := files.List(s.cfg.FilesRoot, p)
	if err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleFilesStat(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	info, err := files.Stat(s.cfg.FilesRoot, p)
	if err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleFilesDownload(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	f, info, err := files.OpenForDownload(s.cfg.FilesRoot, p)
	if err != nil {
		writeFilesError(w, err)
		return
	}
	defer f.Close()

	filename := sanitizeContentDispositionFilename(filepath.Base(p))
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	http.ServeContent(w, r, filename, info.ModTime(), f)
}

func (s *Server) handleFilesContentGet(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	content, truncated, err := files.ReadTextContent(s.cfg.FilesRoot, p)
	if err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": content, "truncated": truncated})
}

func (s *Server) handleFilesContentPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	if err := files.WriteTextContent(s.cfg.FilesRoot, body.Path, body.Content); err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFilesMkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	if err := files.Mkdir(s.cfg.FilesRoot, body.Path); err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (s *Server) handleFilesRename(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Path == "" || body.NewName == "" {
		writeError(w, http.StatusBadRequest, "path and newName are required")
		return
	}
	if err := files.Rename(s.cfg.FilesRoot, body.Path, body.NewName); err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFilesMove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items   []string `json:"items"`
		DestDir string   `json:"destDir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(body.Items) == 0 || body.DestDir == "" {
		writeError(w, http.StatusBadRequest, "items and destDir are required")
		return
	}
	results := files.Move(s.cfg.FilesRoot, body.Items, body.DestDir)
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleFilesCopy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items   []string `json:"items"`
		DestDir string   `json:"destDir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(body.Items) == 0 || body.DestDir == "" {
		writeError(w, http.StatusBadRequest, "items and destDir are required")
		return
	}
	results := files.Copy(s.cfg.FilesRoot, body.Items, body.DestDir)
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleFilesDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []string `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items is required")
		return
	}
	results := files.Delete(s.cfg.FilesRoot, body.Items)
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// handleFilesUpload streams a multipart/form-data upload straight to disk
// (r.MultipartReader, not ParseMultipartForm) so an upload's size is never
// buffered in memory or a temp file by the multipart parser itself — see
// filemanager-plan.md's "스트리밍 업로드" section. server.go's
// limitRequestBody middleware skips this route entirely; the cap here
// (WEBMANAGER_FILES_MAX_UPLOAD_BYTES) is applied directly via
// http.MaxBytesReader before anything reads the body.
//
// Expected form fields: a "dir" field (target directory) that must appear
// before any "files" part in the multipart stream (this handler reads parts
// in order and needs the directory before it can validate/open the first
// file), followed by one or more "files" parts.
func (s *Server) handleFilesUpload(w http.ResponseWriter, r *http.Request) {
	maxUpload, err := strconv.ParseInt(s.cfg.FilesMaxUploadBytes, 10, 64)
	if err != nil || maxUpload <= 0 {
		maxUpload = 2 * 1024 * 1024 * 1024
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)

	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart request")
		return
	}

	var dir string
	var results []files.UploadResult

	for {
		part, perr := mr.NextPart()
		if perr == io.EOF {
			break
		}
		if perr != nil {
			writeError(w, http.StatusBadRequest, "malformed multipart body: "+perr.Error())
			return
		}

		switch part.FormName() {
		case "dir":
			data, rerr := io.ReadAll(io.LimitReader(part, 4096))
			part.Close()
			if rerr != nil {
				writeError(w, http.StatusBadRequest, "failed reading dir field")
				return
			}
			dir = strings.TrimSpace(string(data))

		case "files":
			name := part.FileName()
			if dir == "" {
				part.Close()
				results = append(results, files.UploadResult{Name: name, Ok: false, Error: "dir field must precede files parts"})
				continue
			}

			dest, f, oerr := files.OpenUploadDest(s.cfg.FilesRoot, dir, name)
			if oerr != nil {
				part.Close()
				results = append(results, files.UploadResult{Name: name, Ok: false, Error: oerr.Error()})
				continue
			}

			_, cerr := io.Copy(f, part)
			f.Close()
			part.Close()
			if cerr != nil {
				_ = os.Remove(dest)
				results = append(results, files.UploadResult{Name: name, Ok: false, Error: cerr.Error()})
				continue
			}
			results = append(results, files.UploadResult{Name: name, Ok: true})

		default:
			part.Close()
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func sanitizeContentDispositionFilename(name string) string {
	name = strings.ReplaceAll(name, "\r", "")
	name = strings.ReplaceAll(name, "\n", "")
	name = strings.ReplaceAll(name, `"`, "'")
	return name
}
