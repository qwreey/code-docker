package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func feedAll(seq []byte, chunks ...[]byte) (forward []byte, detached bool) {
	m := &detachMatcher{seq: seq}
	for _, c := range chunks {
		var f []byte
		f, detached = m.feed(c)
		forward = append(forward, f...)
		if detached {
			return forward, true
		}
	}
	return forward, false
}

func TestDetachMatcherExactMatch(t *testing.T) {
	forward, detached := feedAll([]byte{0x10, 0x11}, []byte{0x10, 0x11})
	if !detached {
		t.Fatalf("want detached=true")
	}
	if len(forward) != 0 {
		t.Fatalf("forward = %q, want empty", forward)
	}
}

func TestDetachMatcherSplitAcrossReads(t *testing.T) {
	forward, detached := feedAll([]byte{0x10, 0x11}, []byte{0x10}, []byte{0x11})
	if !detached {
		t.Fatalf("want detached=true across two reads")
	}
	if len(forward) != 0 {
		t.Fatalf("forward = %q, want empty", forward)
	}
}

func TestDetachMatcherPassesThroughUnrelatedInput(t *testing.T) {
	forward, detached := feedAll([]byte{0x10, 0x11}, []byte("hello"))
	if detached {
		t.Fatalf("want detached=false for unrelated input")
	}
	if string(forward) != "hello" {
		t.Fatalf("forward = %q, want %q", forward, "hello")
	}
}

func TestDetachMatcherFlushesBrokenPartialMatch(t *testing.T) {
	// seq "AB", input "AC" - the leading 'A' looked like the start of a
	// match but the next byte broke it, so both bytes must reach the PTY.
	forward, detached := feedAll([]byte("AB"), []byte("AC"))
	if detached {
		t.Fatalf("want detached=false")
	}
	if string(forward) != "AC" {
		t.Fatalf("forward = %q, want %q", forward, "AC")
	}
}

func TestDetachMatcherRestartsOnBrokenMatchByte(t *testing.T) {
	// seq "AB", input "AAB" - first 'A' isn't followed by 'B' so it's a
	// real keystroke, but the second 'A' immediately restarts a fresh
	// match that the trailing 'B' then completes.
	forward, detached := feedAll([]byte("AB"), []byte("AAB"))
	if !detached {
		t.Fatalf("want detached=true")
	}
	if string(forward) != "A" {
		t.Fatalf("forward = %q, want %q", forward, "A")
	}
}

func TestDetachMatcherSingleByteSequence(t *testing.T) {
	forward, detached := feedAll([]byte{0x1d}, []byte{'x', 0x1d})
	if !detached {
		t.Fatalf("want detached=true")
	}
	if string(forward) != "x" {
		t.Fatalf("forward = %q, want %q", forward, "x")
	}
}

func TestDescribeDetachSequence(t *testing.T) {
	cases := []struct {
		seq  []byte
		want string
	}{
		{defaultDetachSequence, "Ctrl+]"},
		{[]byte{0x10, 0x11}, "Ctrl+P Ctrl+Q"},
		{[]byte{0x01}, "Ctrl+A"},
		{[]byte{'q'}, "q"},
	}
	for _, c := range cases {
		if got := describeDetachSequence(c.seq); got != c.want {
			t.Errorf("describeDetachSequence(%q) = %q, want %q", c.seq, got, c.want)
		}
	}
}

// sessionExists drives the "joining existing" vs "creating new" wording of
// attachCmd's banner, so a wrong answer here is exactly the silent
// mismatch that banner exists to make visible.
func TestSessionExists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "webmanager_unlock=tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `[{"name":"quad"},{"name":"세션 1"}]`)
	}))
	defer srv.Close()

	for _, c := range []struct {
		name       string
		wantExists bool
		wantKnown  bool
	}{
		{"quad", true, true},
		{"세션 1", true, true},
		{"quad2", false, true},
	} {
		exists, known := sessionExists(srv.URL, "webmanager_unlock=tok", c.name)
		if exists != c.wantExists || known != c.wantKnown {
			t.Errorf("sessionExists(%q) = (%v, %v), want (%v, %v)", c.name, exists, known, c.wantExists, c.wantKnown)
		}
	}

	// A gate rejecting the cookie (or any other non-200) must report
	// "unknown", not "doesn't exist" - the banner then says less rather
	// than claiming a join is a create.
	if exists, known := sessionExists(srv.URL, "", "quad"); exists || known {
		t.Errorf("sessionExists with rejected cookie = (%v, %v), want (false, false)", exists, known)
	}
	if exists, known := sessionExists("http://127.0.0.1:1", "", "quad"); exists || known {
		t.Errorf("sessionExists against a dead server = (%v, %v), want (false, false)", exists, known)
	}
}
