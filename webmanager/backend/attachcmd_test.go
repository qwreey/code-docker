package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func feedAll(seq []byte, chunks ...[]byte) (forward []byte, detached bool) {
	m := newDetachMatcher(seq)
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

// The bug this pins: fish (and anything else that turns on the kitty
// keyboard protocol or xterm's modifyOtherKeys while at its prompt) makes
// the terminal report Ctrl+] as an escape sequence instead of 0x1d, so the
// detach key did nothing at a shell prompt while working fine under a plain
// foreground program like `cat -v`.
func TestDetachMatcherRecognizesEscapeEncodedKey(t *testing.T) {
	for _, encoded := range []string{"\x1b[93;5u", "\x1b[27;5;93~"} {
		forward, detached := feedAll(defaultDetachSequence, []byte(encoded))
		if !detached {
			t.Errorf("%q: want detached=true", encoded)
		}
		if len(forward) != 0 {
			t.Errorf("%q: forward = %q, want empty", encoded, forward)
		}
	}
}

func TestDetachMatcherEscapeEncodedTwoKeySequence(t *testing.T) {
	// Ctrl+P Ctrl+Q, with each key independently in either encoding.
	forward, detached := feedAll([]byte{0x10, 0x11}, []byte("\x1b[112;5u"), []byte{0x11})
	if !detached {
		t.Fatalf("want detached=true")
	}
	if len(forward) != 0 {
		t.Fatalf("forward = %q, want empty", forward)
	}
}

// A lone Escape must reach the remote immediately - vim and friends treat
// it as an action, so holding it back until the next keystroke would be
// worse than missing a detach.
func TestDetachMatcherFlushesLoneEscapeAtChunkEnd(t *testing.T) {
	m := newDetachMatcher(defaultDetachSequence)
	forward, detached := m.feed([]byte{0x1b})
	if detached {
		t.Fatalf("want detached=false")
	}
	if !bytes.Equal(forward, []byte{0x1b}) {
		t.Fatalf("forward = %q, want a lone ESC", forward)
	}
}

// An escape sequence that merely looks like the start of the encoded detach
// key must still reach the remote intact once it turns out not to be one.
func TestDetachMatcherForwardsUnrelatedEscapeSequence(t *testing.T) {
	arrowUp := []byte("\x1b[A")
	forward, detached := feedAll(defaultDetachSequence, arrowUp)
	if detached {
		t.Fatalf("want detached=false")
	}
	if !bytes.Equal(forward, arrowUp) {
		t.Fatalf("forward = %q, want %q", forward, arrowUp)
	}
}

func TestDetachCandidates(t *testing.T) {
	keys := detachCandidates([]byte{0x01}) // Ctrl+A -> unshifted 'a' = 97
	if len(keys) != 1 {
		t.Fatalf("got %d keys, want 1", len(keys))
	}
	want := []string{"\x01", "\x1b[97;5u", "\x1b[27;5;97~"}
	if len(keys[0]) != len(want) {
		t.Fatalf("got %d encodings, want %d: %q", len(keys[0]), len(want), keys[0])
	}
	for i := range want {
		if string(keys[0][i]) != want[i] {
			t.Errorf("encoding %d = %q, want %q", i, keys[0][i], want[i])
		}
	}
}
