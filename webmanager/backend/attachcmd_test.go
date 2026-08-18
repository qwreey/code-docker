package main

import "testing"

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
