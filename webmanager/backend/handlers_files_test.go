package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// An upload with no file parts must answer "results": [], not null - the
// frontend iterates it.
func TestFilesUploadEmptyResultsIsArray(t *testing.T) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("dir", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mw.Close()

	s := &Server{cfg: Config{FilesRoot: "/", FilesMaxUploadBytes: "1048576"}}
	req := httptest.NewRequest(http.MethodPost, "/api/files/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	s.handleFilesUpload(rec, req)

	if !strings.Contains(rec.Body.String(), `"results":[]`) {
		t.Fatalf("status %d, body %s - want \"results\":[]", rec.Code, rec.Body.String())
	}
}
