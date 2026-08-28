package termsession

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func feedAll(m *modeTracker, chunks ...string) {
	for _, c := range chunks {
		m.Feed([]byte(c))
	}
}

// TestPreambleSurvivesRingEviction is the bug this whole file exists for:
// the alt-screen enable sequence is written once and then buried under far
// more output than the scrollback ring can hold, so the ring's snapshot no
// longer contains it while the session is very much still in the alt buffer.
func TestPreambleSurvivesRingEviction(t *testing.T) {
	m := newModeTracker()
	ring := newRingBuffer(1024)

	enter := "\x1b[?1049h\x1b[?2004h\x1b[?25l"
	m.Feed([]byte(enter))
	ring.Write([]byte(enter))
	for i := 0; i < 100; i++ {
		redraw := []byte("\x1b[H\x1b[2Jsome full-screen redraw output line\r\n")
		m.Feed(redraw)
		ring.Write(redraw)
	}

	if bytes.Contains(ring.Snapshot(), []byte("\x1b[?1049h")) {
		t.Fatal("ring still holds the enable sequence; the test no longer exercises eviction")
	}
	got := string(m.Preamble())
	if !strings.HasPrefix(got, "\x1b[?1049h") {
		t.Errorf("preamble = %q, want it to start by re-entering the alt screen", got)
	}
	for _, want := range []string{"\x1b[?2004h", "\x1b[?25l"} {
		if !strings.Contains(got, want) {
			t.Errorf("preamble = %q, missing %q", got, want)
		}
	}
}

func TestPreambleEmptyAtDefaults(t *testing.T) {
	m := newModeTracker()
	// Modes set and then put back, plus untracked ones and ordinary output.
	feedAll(m, "hello\r\n", "\x1b[?1049h", "\x1b[?2004h", "vim-ish drawing",
		"\x1b[?2004l", "\x1b[?1049l", "\x1b[?9001h", "\x1b[31mred\x1b[0m")
	if got := m.Preamble(); got != nil {
		t.Errorf("Preamble() = %q, want nil once every tracked mode is back at its default", got)
	}
}

func TestFeedHandlesSplitSequences(t *testing.T) {
	m := newModeTracker()
	// pump() reads fixed-size chunks with no regard for escape-sequence
	// boundaries, so every split has to parse the same as the whole.
	feedAll(m, "\x1b", "[?10", "49", "h")
	if got, want := string(m.Preamble()), "\x1b[?1049h"; got != want {
		t.Errorf("Preamble() = %q, want %q", got, want)
	}
}

func TestFeedIgnoresSequencesInsideStrings(t *testing.T) {
	m := newModeTracker()
	// An OSC payload (here a window title) can contain anything; it must not
	// be scanned for mode changes that were never really requested.
	feedAll(m, "\x1b]0;\x1b[?1049h\x07", "plain output")
	if got := m.Preamble(); got != nil {
		t.Errorf("Preamble() = %q, want nil (the sequence was inside an OSC string)", got)
	}
	// Same again with an ST-terminated string, and confirm the parser
	// recovers afterwards rather than swallowing the rest of the stream.
	feedAll(m, "\x1bP\x1b[?1049h\x1b\\", "\x1b[?2004h")
	if got, want := string(m.Preamble()), "\x1b[?2004h"; got != want {
		t.Errorf("Preamble() = %q, want %q", got, want)
	}
}

func TestFeedMultiParamAndKeypad(t *testing.T) {
	m := newModeTracker()
	feedAll(m, "\x1b[?1000;1002;1006h", "\x1b=")
	got := string(m.Preamble())
	for _, want := range []string{"\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h", "\x1b="} {
		if !strings.Contains(got, want) {
			t.Errorf("Preamble() = %q, missing %q", got, want)
		}
	}
	feedAll(m, "\x1b[?1000;1002;1006l", "\x1b>")
	if got := m.Preamble(); got != nil {
		t.Errorf("Preamble() = %q, want nil after the same modes are reset", got)
	}
}

// TestPreambleRestoresVimStartupState feeds the exact sequence a real vim
// writes when it starts (captured from a PTY in this image, 2026-08-29) and
// checks every set-once piece of it comes back. The scroll region and the
// key-modifier resource are the two that a mode-only tracker missed: vim
// emits each exactly once and never again, not even on SIGWINCH.
func TestPreambleRestoresVimStartupState(t *testing.T) {
	m := newModeTracker()
	feedAll(m,
		"\x1b[?1049h", "\x1b[>4;2m", "\x1b[?1h", "\x1b=", "\x1b[?2004h",
		"\x1b[?1004h", "\x1b[1;24r", "\x1b[?12h", "\x1b[?1002h",
		"\x1b[?1006;1000h", "\x1b[2 q",
		// ... and then a redraw, which re-emits none of it.
		"\x1b[H\x1b[2J\x1b[31msome text\x1b[m\r\n",
	)
	got := string(m.Preamble())
	for _, want := range []string{
		"\x1b[?1049h", "\x1b[>4;2m", "\x1b[?1h", "\x1b=", "\x1b[?2004h",
		"\x1b[?1004h", "\x1b[1;24r", "\x1b[?12h", "\x1b[?1002h",
		"\x1b[?1006h", "\x1b[?1000h", "\x1b[2 q",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("preamble = %q, missing %q", got, want)
		}
	}
	// Order matters for these two: the alt screen has to be entered before
	// anything else (it clears that buffer), and the scroll region has to be
	// set after it, since the region is per-buffer.
	if !strings.HasPrefix(got, "\x1b[?1049h") {
		t.Errorf("preamble = %q, want the alt screen entered first", got)
	}
	if strings.Index(got, "\x1b[1;24r") < strings.Index(got, "\x1b[?1049h") {
		t.Errorf("preamble = %q, want the scroll region set after the alt screen switch", got)
	}
}

// TestPreambleRestoresCharsets covers the box-drawing case: an application
// that designates the line-drawing set once and then flips into it with bare
// SO/SI bytes renders its borders as ASCII letters on a client that missed
// the designation.
func TestPreambleRestoresCharsets(t *testing.T) {
	m := newModeTracker()
	feedAll(m, "\x1b)0", "\x0e", "lqqqk")
	got := string(m.Preamble())
	if !strings.Contains(got, "\x1b)0") {
		t.Errorf("preamble = %q, want G1 designated as line drawing", got)
	}
	if !strings.Contains(got, "\x0e") {
		t.Errorf("preamble = %q, want G1 invoked into GL (SO)", got)
	}
	// Shifting back to G0 is the default level, so only the designation
	// itself should remain.
	feedAll(m, "\x0f")
	if got := string(m.Preamble()); strings.Contains(got, "\x0e") {
		t.Errorf("preamble = %q, want no SO once shifted back in", got)
	}
	// A designation is state, not a one-shot: replacing it must not stack.
	feedAll(m, "\x1b)B")
	if got, want := string(m.Preamble()), "\x1b)B"; got != want {
		t.Errorf("preamble = %q, want %q", got, want)
	}
}

// TestScrollRegionAndCursorStyleResetToDefault checks the two pieces of
// state whose "back to default" spelling is not an "l" — a bare CSI r and
// DECSCUSR 0 — are recognized as default rather than restored verbatim.
func TestScrollRegionAndCursorStyleResetToDefault(t *testing.T) {
	m := newModeTracker()
	feedAll(m, "\x1b[1;24r", "\x1b[4 q")
	if got := m.Preamble(); len(got) == 0 {
		t.Fatal("Preamble() = nil, want the region and cursor style recorded")
	}
	feedAll(m, "\x1b[r", "\x1b[0 q")
	if got := m.Preamble(); got != nil {
		t.Errorf("Preamble() = %q, want nil once both are back at their default", got)
	}
}

func TestPreambleRestoresAnsiModes(t *testing.T) {
	m := newModeTracker()
	// "\x1b[4h" is IRM; the "?"-less form must not be confused with DEC
	// private mode 4, which is a different (unimplemented) mode entirely.
	feedAll(m, "\x1b[4h", "\x1b[?4h")
	if got, want := string(m.Preamble()), "\x1b[4h"; got != want {
		t.Errorf("Preamble() = %q, want %q", got, want)
	}
	feedAll(m, "\x1b[4l")
	if got := m.Preamble(); got != nil {
		t.Errorf("Preamble() = %q, want nil", got)
	}
}

// TestResetModesSequenceLeavesAltScreenLast pins the ordering `webmanager
// --attach` depends on: leaving the alternate buffer has to be the last
// thing written, so the rest of the restore applies to the screen the user
// is actually returned to.
func TestResetModesSequenceLeavesAltScreenLast(t *testing.T) {
	got := string(ResetModesSequence())
	if !strings.HasSuffix(got, "\x1b[?1049l\x1b[?1047l\x1b[?47l") {
		t.Errorf("ResetModesSequence() = %q, want it to end by leaving the alt screen", got)
	}
	for _, want := range []string{
		"\x1b[?25h", "\x1b[?2004l", "\x1b[?1006l", "\x1b>",
		"\x1b[4l", "\x1b[>4;m", "\x1b(B", "\x1b)B", "\x0f", "\x1b[r", "\x1b[0 q",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("ResetModesSequence() = %q, missing %q", got, want)
		}
	}
	// Every mode the tracker can restore must have a counterpart here, or a
	// detaching attach client leaves the user's terminal in it.
	m := newModeTracker()
	for mode, def := range decModeDefault {
		var b strings.Builder
		writeDECMode(&b, mode, !def)
		m.Feed([]byte(b.String()))
	}
	for mode := range decModeDefault {
		var b strings.Builder
		writeDECMode(&b, mode, decModeDefault[mode])
		if !strings.Contains(got, b.String()) {
			t.Errorf("ResetModesSequence() = %q, missing the default for mode %d", got, mode)
		}
	}
	if len(m.Preamble()) == 0 {
		t.Fatal("tracker recorded nothing; the loop above is not exercising the mode table")
	}
}

// TestAttachReplayRestoresAltScreenAfterEviction is the end-to-end version
// of TestPreambleSurvivesRingEviction: a real PTY, a real (deliberately
// tiny) scrollback ring, and the Attach path a reconnecting client actually
// takes. Before the tracker existed, a client attaching here was handed a
// replay with no way to know it was looking at a full-screen application.
func TestAttachReplayRestoresAltScreenAfterEviction(t *testing.T) {
	s, err := newSession("alt-screen-test", "/bin/sh", 512, CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("newSession() = %v", err)
	}
	defer s.Close()

	// Enter the alternate screen the way an application does, then bury the
	// sequence under more output than the 512-byte ring can hold.
	if _, err := s.Write([]byte("printf '\\033[?1049h\\033[?2004h'; i=0; while [ $i -lt 60 ]; do printf 'redraw line %d\\n' $i; i=$((i+1)); done\n")); err != nil {
		t.Fatalf("Write() = %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		detach, replay, aerr := s.Attach(func(p []byte) error { return nil })
		if aerr != nil {
			t.Fatalf("Attach() = %v", aerr)
		}
		detach()
		if bytes.Contains(replay.Preamble, []byte("\x1b[?1049h")) {
			if bytes.Contains(replay.Scrollback, []byte("\x1b[?1049h")) {
				t.Fatal("the ring still holds the enable sequence; raise the output volume so this test exercises eviction")
			}
			if !bytes.Contains(replay.Preamble, []byte("\x1b[?2004h")) {
				t.Errorf("preamble = %q, want bracketed paste restored too", replay.Preamble)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("preamble never reported the alt screen; last = %q", replay.Preamble)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
