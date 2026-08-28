package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webmanager/internal/termsession"
)

// TestWriteScrollbackFitsDefaultClientReadLimit pins the bug that made
// `webmanager --attach <an existing, used session>` exit immediately while
// attaching to a brand-new name worked: the scrollback replay went out as a
// single WebSocket message, and coder/websocket (attachcmd.go's client)
// aborts any message over its default 32KiB read limit. The client here
// deliberately does NOT raise that limit - that's the whole point.
func TestWriteScrollbackFitsDefaultClientReadLimit(t *testing.T) {
	replay := termsession.Replay{Scrollback: bytes.Repeat([]byte("x"), 256*1024)}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		if err := writeScrollback(r.Context(), conn, replay); err != nil {
			t.Errorf("writeScrollback: %v", err)
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	var got []byte
	for len(got) < len(replay.Scrollback)+len("\x1b[2J\x1b[H") {
		_, data, rerr := conn.Read(ctx)
		if rerr != nil {
			t.Fatalf("read after %d bytes: %v", len(got), rerr)
		}
		got = append(got, data...)
	}

	want := append([]byte("\x1b[2J\x1b[H"), replay.Scrollback...)
	if !bytes.Equal(got, want) {
		t.Fatalf("replayed %d bytes, want %d (and byte-identical)", len(got), len(want))
	}
}

func TestParseAttachSize(t *testing.T) {
	cases := []struct {
		query string
		want  attachSize
	}{
		{"", attachSize{}},
		{"cols=120&rows=40", attachSize{Cols: 120, Rows: 40}},
		// A client that only reports one dimension has told us nothing
		// usable — known() is false, so the session keeps its own size.
		{"cols=120", attachSize{Cols: 120}},
		// Junk is "not told", never an error: a bad size must not be a
		// reason to refuse a terminal connection.
		{"cols=abc&rows=40", attachSize{Rows: 40}},
		{"cols=0&rows=0", attachSize{}},
		{"cols=-5&rows=40", attachSize{Rows: 40}},
		{"cols=99999&rows=40", attachSize{Rows: 40}},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			got := parseAttachSize(httptest.NewRequest(http.MethodGet, "/api/terminal?"+tc.query, nil))
			if got != tc.want {
				t.Fatalf("parseAttachSize(%q) = %+v, want %+v", tc.query, got, tc.want)
			}
			if tc.want.Cols > 0 && tc.want.Rows > 0 && !got.known() {
				t.Fatal("known() should be true when both dimensions parsed")
			}
		})
	}
}
