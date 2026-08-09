package termsession

import (
	"bytes"
	"errors"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestAttachDoesNotDuplicateOrDropOutput guards against a real race: pump()
// writes each PTY chunk into the scrollback ring and (if a client is
// attached) forwards it live as two separate steps; Attach() sets the new
// sink and takes its scrollback snapshot as two separate steps. Without a
// shared lock across both sides, a chunk produced right as a client
// reattaches could land in that client's snapshot AND get forwarded to it
// live immediately after (duplicated), or - depending on interleaving -
// be missed by both (dropped).
//
// This runs a shell loop that continuously emits an increasing sequence
// number, attaches mid-stream, and checks the numbers recovered from
// scrollback+live are contiguous with no repeats across the boundary.
func TestAttachDoesNotDuplicateOrDropOutput(t *testing.T) {
	s, err := newSession("race-test", "/bin/sh", 8192, CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("newSession() = %v", err)
	}
	defer s.Close()

	cmd := "i=0; while true; do i=$((i+1)); echo LINE_$i; done\n"
	if _, err := s.Write([]byte(cmd)); err != nil {
		t.Fatalf("Write() = %v", err)
	}

	// Let the ring accumulate a real backlog before attaching, so the
	// snapshot/live boundary is actually exercised under load.
	time.Sleep(150 * time.Millisecond)

	var mu sync.Mutex
	var live bytes.Buffer
	detach, scrollback, err := s.Attach(func(p []byte) error {
		mu.Lock()
		live.Write(p)
		mu.Unlock()
		return nil
	})
	if err != nil {
		t.Fatalf("Attach() = %v", err)
	}

	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	liveCopy := append([]byte(nil), live.Bytes()...)
	mu.Unlock()
	detach()

	combined := append(append([]byte(nil), scrollback...), liveCopy...)

	re := regexp.MustCompile(`LINE_(\d+)`)
	matches := re.FindAllStringSubmatch(string(combined), -1)
	if len(matches) < 10 {
		t.Fatalf("only recovered %d LINE_N markers, want enough to exercise the boundary", len(matches))
	}

	seen := map[int]bool{}
	for _, m := range matches {
		n, _ := strconv.Atoi(m[1])
		if seen[n] {
			t.Fatalf("LINE_%d appeared more than once across scrollback+live - duplicate-output race", n)
		}
		seen[n] = true
	}
	for i := range matches {
		n, _ := strconv.Atoi(matches[i][1])
		if i > 0 {
			prev, _ := strconv.Atoi(matches[i-1][1])
			if n != prev+1 {
				t.Fatalf("sequence gap: LINE_%d immediately followed by LINE_%d - dropped output", prev, n)
			}
		}
	}
}

// TestSinkErrorDoesNotBlockPump guards the write-timeout fix's assumption:
// pump() must keep draining the PTY even when the attached sink errors
// (simulating a stalled client's write finally timing out) rather than
// getting stuck forever on one bad sink call.
func TestSinkErrorDoesNotBlockPump(t *testing.T) {
	s, err := newSession("error-test", "/bin/sh", 8192, CreateOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("newSession() = %v", err)
	}
	defer s.Close()

	var calls atomic.Int32
	detach, _, err := s.Attach(func(p []byte) error {
		calls.Add(1)
		return errors.New("simulated stalled write")
	})
	if err != nil {
		t.Fatalf("Attach() = %v", err)
	}
	defer detach()

	if _, err := s.Write([]byte("echo hi\n")); err != nil {
		t.Fatalf("Write() = %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	if calls.Load() == 0 {
		t.Fatalf("sink was never called")
	}
	if _, _, attached := s.reapCheck(time.Now()); attached {
		t.Fatalf("reapCheck still reports attached=%v after sink errored, want the sink to have been cleared", attached)
	}
}

