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
)

// TestWriteScrollbackFitsDefaultClientReadLimit pins the bug that made
// `webmanager --attach <an existing, used session>` exit immediately while
// attaching to a brand-new name worked: the scrollback replay went out as a
// single WebSocket message, and coder/websocket (attachcmd.go's client)
// aborts any message over its default 32KiB read limit. The client here
// deliberately does NOT raise that limit - that's the whole point.
func TestWriteScrollbackFitsDefaultClientReadLimit(t *testing.T) {
	scrollback := bytes.Repeat([]byte("x"), 256*1024)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		if err := writeScrollback(r.Context(), conn, scrollback); err != nil {
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
	for len(got) < len(scrollback)+len("\x1b[2J\x1b[H") {
		_, data, rerr := conn.Read(ctx)
		if rerr != nil {
			t.Fatalf("read after %d bytes: %v", len(got), rerr)
		}
		got = append(got, data...)
	}

	want := append([]byte("\x1b[2J\x1b[H"), scrollback...)
	if !bytes.Equal(got, want) {
		t.Fatalf("replayed %d bytes, want %d (and byte-identical)", len(got), len(want))
	}
}
