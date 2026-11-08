package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"webmanager/internal/webdavshare"
)

func TestPutWebDAVPasswordRefusesShortWith400(t *testing.T) {
	s := &Server{webdav: webdavshare.New(webdavshare.Options{
		SettingsPath: filepath.Join(t.TempDir(), "webdav.json"),
		Root:         t.TempDir(),
	})}
	put := func(pw string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/webdav/password", strings.NewReader(`{"password":"`+pw+`"}`))
		rec := httptest.NewRecorder()
		s.handlePutWebDAVPassword(rec, req)
		return rec
	}

	if rec := put("가나다라마바사아자차카"); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "12") {
		t.Fatalf("11-character password: %d %s, want 400 naming the minimum", rec.Code, rec.Body.String())
	}
	if s.webdav.Status().HasPassword {
		t.Fatal("a refused password was stored anyway")
	}
	if rec := put("가나다라마바사아자차카타"); rec.Code != http.StatusOK {
		t.Fatalf("12-character password: %d %s, want 200", rec.Code, rec.Body.String())
	}
	// Clearing is not choosing a password, so it stays allowed.
	if rec := put(""); rec.Code != http.StatusOK || s.webdav.Status().HasPassword {
		t.Fatalf("clearing: %d %s", rec.Code, rec.Body.String())
	}
}
