package extensions

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func vsixFiles(publisher, name string) map[string]string {
	return map[string]string{
		"extension.vsixmanifest": "<PackageManifest/>",
		"extension/package.json": `{"publisher":"` + publisher + `","name":"` + name + `"}`,
	}
}

func gzipBytes(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestVerifyVSIX(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
		id      string
		wantErr string
	}{
		{"matching", makeZip(t, vsixFiles("ms-python", "python")), "ms-python.python", ""},
		{"case-insensitive id", makeZip(t, vsixFiles("MS-Python", "Python")), "ms-python.python", ""},
		{"different extension", makeZip(t, vsixFiles("evil", "thing")), "ms-python.python", "not ms-python.python"},
		{"not a zip", []byte("<html>not found</html>"), "ms-python.python", "not a valid .vsix"},
		{"zip without manifest", makeZip(t, map[string]string{"extension/package.json": `{}`}), "a.b", "not a VS Code extension"},
		{"zip without package.json", makeZip(t, map[string]string{"extension.vsixmanifest": "x"}), "a.b", "not a VS Code extension"},
		{"unreadable package.json", makeZip(t, map[string]string{"extension.vsixmanifest": "x", "extension/package.json": "nope"}), "a.b", "unreadable package.json"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "x.vsix")
			if err := os.WriteFile(path, tt.content, 0o600); err != nil {
				t.Fatal(err)
			}
			err := VerifyVSIX(path, tt.id)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)):
				t.Fatalf("error = %v, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestDownloadVSIX(t *testing.T) {
	vsix := makeZip(t, vsixFiles("foo", "bar"))

	tests := []struct {
		name    string
		handler http.HandlerFunc
		limit   int64
		wantErr string
	}{
		{
			name: "plain body",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(vsix)
			},
			limit: 1 << 20,
		},
		{
			// A hop that drops Content-Encoding but leaves the payload gzipped.
			name: "gzip payload without header",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(gzipBytes(t, vsix))
			},
			limit: 1 << 20,
		},
		{
			name: "gzip with content-encoding",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Encoding", "gzip")
				_, _ = w.Write(gzipBytes(t, vsix))
			},
			limit: 1 << 20,
		},
		{
			name: "not on marketplace",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			},
			limit:   1 << 20,
			wantErr: "not on the marketplace",
		},
		{
			name: "server error",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
			},
			limit:   1 << 20,
			wantErr: "HTTP 502",
		},
		{
			name: "over the limit",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(bytes.Repeat([]byte("x"), 4096))
			},
			limit:   1024,
			wantErr: "larger than",
		},
		{
			name: "gzip bomb stays under the limit after decompression",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(gzipBytes(t, bytes.Repeat([]byte("x"), 1<<20)))
			},
			limit:   4096,
			wantErr: "larger than",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotPath string
			s := openVSXServer(t, func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				tt.handler(w, r)
			})
			dst := filepath.Join(t.TempDir(), "out.vsix")
			err := s.downloadVSIX(context.Background(), "foo.bar", dst, tt.limit)
			if gotPath != "/_apis/public/gallery/publishers/foo/vsextensions/bar/latest/vspackage" {
				t.Errorf("unexpected request path %q", gotPath)
			}
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(dst)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, vsix) {
				t.Errorf("downloaded %d bytes, want the original %d", len(got), len(vsix))
			}
		})
	}
}

func TestInstallFileArgs(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	bin := filepath.Join(dir, "fake-code-server")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > " + argsFile + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	vsix := filepath.Join(dir, "x.vsix")
	if err := InstallFile(context.Background(), bin, "/ud", "/ed", vsix); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	want := "--user-data-dir=/ud\n--extensions-dir=/ed\n--install-extension=" + vsix + "\n"
	if string(got) != want {
		t.Errorf("args = %q, want %q", got, want)
	}

	if err := InstallFile(context.Background(), bin, "/ud", "/ed", "--evil.vsix"); err == nil {
		t.Error("a relative, flag-like path must be refused")
	}
}

func TestInstallFromMarketplaceVSIX(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	bin := filepath.Join(dir, "fake-code-server")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > " + argsFile + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	serve := func(pub, name string) Sources {
		return openVSXServer(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(makeZip(t, vsixFiles(pub, name)))
		})
	}

	if err := serve("foo", "bar").InstallFromMarketplaceVSIX(context.Background(), bin, "/ud", "/ed", "foo.bar"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "--install-extension=") || !strings.HasSuffix(strings.TrimSpace(string(got)), "foo.bar.vsix") {
		t.Errorf("unexpected install args %q", got)
	}

	// The package is somebody else's extension: nothing may be installed.
	if err := os.Remove(argsFile); err != nil {
		t.Fatal(err)
	}
	err = serve("evil", "thing").InstallFromMarketplaceVSIX(context.Background(), bin, "/ud", "/ed", "foo.bar")
	if err == nil || !strings.Contains(err.Error(), "not foo.bar") {
		t.Fatalf("error = %v, want an identity mismatch", err)
	}
	if _, statErr := os.Stat(argsFile); statErr == nil {
		t.Error("code-server ran despite the identity mismatch")
	}
}
