package extensions

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseInput(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    Parsed
		wantErr error
	}{
		{"bare id", "ms-python.python", Parsed{SourceID, "ms-python.python"}, nil},
		{"bare id with whitespace", "  esbenp.prettier-vscode\n", Parsed{SourceID, "esbenp.prettier-vscode"}, nil},
		{"marketplace url", "https://marketplace.visualstudio.com/items?itemName=ms-python.python", Parsed{SourceMarketplace, "ms-python.python"}, nil},
		{"marketplace url with extra params", "https://marketplace.visualstudio.com/items?itemName=foo.bar&ssr=false#overview", Parsed{SourceMarketplace, "foo.bar"}, nil},
		{"marketplace url trailing slash path", "https://marketplace.visualstudio.com/items/?itemName=foo.bar", Parsed{SourceMarketplace, "foo.bar"}, nil},
		{"marketplace url upper-case host", "https://Marketplace.VisualStudio.com/items?itemName=foo.bar", Parsed{SourceMarketplace, "foo.bar"}, nil},
		{"open-vsx url", "https://open-vsx.org/extension/redhat/java", Parsed{SourceOpenVSX, "redhat.java"}, nil},
		{"open-vsx url with version", "https://open-vsx.org/extension/redhat/java/1.2.3", Parsed{SourceOpenVSX, "redhat.java"}, nil},
		{"open-vsx url with trailing slash", "https://open-vsx.org/extension/redhat/java/", Parsed{SourceOpenVSX, "redhat.java"}, nil},
		{"url inside a sentence", "please install: https://marketplace.visualstudio.com/items?itemName=foo.bar thanks", Parsed{SourceMarketplace, "foo.bar"}, nil},
		{"url followed by full stop", "see https://open-vsx.org/extension/foo/bar.", Parsed{SourceOpenVSX, "foo.bar"}, nil},
		{"url in parentheses", "(https://open-vsx.org/extension/foo/bar)", Parsed{SourceOpenVSX, "foo.bar"}, nil},
		{"first recognized url wins", "https://example.com/x https://open-vsx.org/extension/a/b https://open-vsx.org/extension/c/d", Parsed{SourceOpenVSX, "a.b"}, nil},
		{"unrelated url skipped", "https://github.com/foo/bar https://open-vsx.org/extension/a/b", Parsed{SourceOpenVSX, "a.b"}, nil},
		{"invalid link skipped for a valid one", "https://open-vsx.org/extension/-x/b https://open-vsx.org/extension/a/b", Parsed{SourceOpenVSX, "a.b"}, nil},

		{"empty", "", Parsed{}, ErrNoExtension},
		{"whitespace only", " \n\t", Parsed{}, ErrNoExtension},
		{"plain prose", "install the python thing", Parsed{}, ErrNoExtension},
		{"bare id inside prose is not picked", "install ms-python.python please", Parsed{}, ErrNoExtension},
		{"unrelated url", "https://github.com/foo/bar", Parsed{}, ErrNoExtension},
		{"lookalike host", "https://marketplace.visualstudio.com.evil.example/items?itemName=foo.bar", Parsed{}, ErrNoExtension},
		{"host as userinfo", "https://open-vsx.org@evil.example/extension/foo/bar", Parsed{}, ErrNoExtension},
		{"open-vsx wrong path", "https://open-vsx.org/namespace/foo", Parsed{}, ErrNoExtension},
		{"open-vsx missing name", "https://open-vsx.org/extension/foo", Parsed{}, ErrNoExtension},
		{"marketplace other page", "https://marketplace.visualstudio.com/search?term=foo.bar", Parsed{}, ErrNoExtension},
		{"marketplace without itemName", "https://marketplace.visualstudio.com/items", Parsed{}, ErrInvalidID},

		{"marketplace flag-like id", "https://marketplace.visualstudio.com/items?itemName=--install-extension", Parsed{}, ErrInvalidID},
		{"marketplace leading dash", "https://marketplace.visualstudio.com/items?itemName=-foo.bar", Parsed{}, ErrInvalidID},
		{"marketplace no dot", "https://marketplace.visualstudio.com/items?itemName=foobar", Parsed{}, ErrInvalidID},
		{"marketplace path traversal", "https://marketplace.visualstudio.com/items?itemName=../etc.passwd", Parsed{}, ErrInvalidID},
		{"marketplace shell metacharacters", "https://marketplace.visualstudio.com/items?itemName=foo.bar;rm", Parsed{}, ErrInvalidID},
		{"open-vsx encoded slash", "https://open-vsx.org/extension/fo%2Fo/bar", Parsed{}, ErrInvalidID},
		{"open-vsx dotted name", "https://open-vsx.org/extension/foo/bar.baz", Parsed{}, ErrInvalidID},
		{"open-vsx flag-like publisher", "https://open-vsx.org/extension/--x/y", Parsed{}, ErrInvalidID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseInput(tt.in)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("ParseInput(%q) error = %v, want %v", tt.in, err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("ParseInput(%q) = %+v, want %+v", tt.in, got, tt.want)
			}
		})
	}
}

func TestParseInputTooLong(t *testing.T) {
	_, err := ParseInput(strings.Repeat("a", MaxInputLen+1))
	if err == nil || errors.Is(err, ErrNoExtension) {
		t.Fatalf("expected a length error, got %v", err)
	}
}

func TestValidateID(t *testing.T) {
	tests := []struct {
		id string
		ok bool
	}{
		{"ms-python.python", true},
		{"a.b", true},
		{"Foo_Bar.baz-1", true},
		{"", false},
		{"nodot", false},
		{".name", false},
		{"pub.", false},
		{"-pub.name", false},
		{"pub.-name", false},
		{"pub.name.extra", false},
		{"pub/name.x", false},
		{"pub name.x", false},
		{"pub.name\n", false},
		{"--install-extension", false},
	}
	for _, tt := range tests {
		if got := ValidateID(tt.id) == nil; got != tt.ok {
			t.Errorf("ValidateID(%q) ok = %v, want %v", tt.id, got, tt.ok)
		}
	}
}

func openVSXServer(t *testing.T, handler http.HandlerFunc) Sources {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return Sources{OpenVSXBase: srv.URL, MarketplaceBase: srv.URL, HTTP: srv.Client()}
}

func TestLookupOpenVSX(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		want    OpenVSXInfo
		wantErr bool
	}{
		{
			name: "found",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/redhat/java" {
					t.Errorf("unexpected path %q", r.URL.Path)
				}
				_, _ = w.Write([]byte(`{"displayName":"Java","description":"d","homepage":"https://example.com/h","version":"1.2.3"}`))
			},
			want: OpenVSXInfo{Found: true, Label: "Java", Description: "d", Homepage: "https://example.com/h", Version: "1.2.3"},
		},
		{
			name: "homepage that is not http is dropped",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"displayName":"Java","homepage":"javascript:alert(1)"}`))
			},
			want: OpenVSXInfo{Found: true, Label: "Java"},
		},
		{
			name: "404 is not found",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"Extension not found: redhat.java"}`))
			},
			want: OpenVSXInfo{Found: false},
		},
		{
			name: "200 with an error body is not found",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"error":"Extension not found"}`))
			},
			want: OpenVSXInfo{Found: false},
		},
		{
			name: "server error is an error, not a miss",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			},
			wantErr: true,
		},
		{
			name: "rate limit is an error, not a miss",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusTooManyRequests)
			},
			wantErr: true,
		},
		{
			name: "garbage body is an error",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`<html>`))
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := openVSXServer(t, tt.handler)
			got, err := s.LookupOpenVSX(context.Background(), "redhat.java")
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
