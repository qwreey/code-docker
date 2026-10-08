package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webmanager/internal/files"
)

// The shared 1 MiB cap used to cut off font uploads (whose handler has its
// own, larger cap) and editor saves of files the editor itself had opened.
func TestRequestBodyCap(t *testing.T) {
	read := func(method, path string, size int) error {
		var got error
		h := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, got = io.Copy(io.Discard, r.Body)
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, path, strings.NewReader(strings.Repeat("x", size))))
		return got
	}
	for _, c := range []struct {
		method, path string
		size         int
		ok           bool
	}{
		{"POST", "/api/fonts", 3 << 20, true},
		{"POST", "/api/files/upload", 3 << 20, true},
		{"PUT", "/api/files/content", 6 << 20, true},
		{"PUT", "/api/files/content", files.MaxTextSaveBodyBytes + 1, false},
		{"POST", "/api/ssh/keys", 2 << 20, false},
		{"DELETE", "/api/fonts", 2 << 20, false},
	} {
		if err := read(c.method, c.path, c.size); (err == nil) != c.ok {
			t.Errorf("%s %s with %d bytes: err=%v, want ok=%v", c.method, c.path, c.size, err, c.ok)
		}
	}
}
