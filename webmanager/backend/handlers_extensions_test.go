package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"webmanager/internal/extensions"
)

func TestHandleLookupCodeExtension(t *testing.T) {
	openVSX := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/foo/bar" {
			_, _ = w.Write([]byte(`{"displayName":"Bar","version":"1.0.0"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer openVSX.Close()
	s := &Server{extSources: extensions.Sources{OpenVSXBase: openVSX.URL, HTTP: openVSX.Client()}}

	tests := []struct {
		name         string
		text         string
		wantStatus   int
		wantMatched  bool
		wantFound    bool
		wantFallback bool
	}{
		{"on open-vsx", "https://marketplace.visualstudio.com/items?itemName=foo.bar", http.StatusOK, true, true, false},
		{"not on open-vsx offers the fallback", "https://open-vsx.org/extension/nope/missing", http.StatusOK, true, false, true},
		{"nothing recognized", "hello", http.StatusOK, false, false, false},
		{"malformed id", "https://marketplace.visualstudio.com/items?itemName=--flag", http.StatusBadRequest, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/code-extensions/lookup?text="+url.QueryEscape(tt.text), nil)
			rec := httptest.NewRecorder()
			s.handleLookupCodeExtension(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				return
			}
			var got LookupExtensionResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Matched != tt.wantMatched {
				t.Errorf("matched = %v, want %v", got.Matched, tt.wantMatched)
			}
			if tt.wantMatched && (got.OpenVSX == nil || got.OpenVSX.Found != tt.wantFound) {
				t.Errorf("openVsx = %+v, want found=%v", got.OpenVSX, tt.wantFound)
			}
			if (got.VSIXFallback != nil) != tt.wantFallback {
				t.Errorf("vsixFallback = %+v, want present=%v", got.VSIXFallback, tt.wantFallback)
			}
		})
	}
}

func TestHandleInstallCodeExtensionVSIXRejectsBadID(t *testing.T) {
	s := &Server{}
	for _, body := range []string{`{"id":"--install-extension"}`, `{"id":""}`, `not json`} {
		req := httptest.NewRequest(http.MethodPost, "/api/code-extensions/install-vsix", strings.NewReader(body))
		rec := httptest.NewRecorder()
		s.handleInstallCodeExtensionVSIX(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want 400", body, rec.Code)
		}
	}
}
