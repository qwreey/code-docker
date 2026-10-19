package claudecode

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

// TestReadSessionLinesClampsLimit: limit sizes the result slice before the
// file is read, so a huge value from the query string used to be a fatal
// allocation.
func TestReadSessionLinesClampsLimit(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, sessionsDirName, "-code-p")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, "s.jsonl"), []byte("{}\n{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, hasMore, err := ReadSessionLines(dir, "-code-p", "s", 0, math.MaxInt)
	if err != nil || len(lines) != 2 || hasMore {
		t.Fatalf("ReadSessionLines(MaxInt) = %d lines, hasMore=%v, %v; want 2, false, nil", len(lines), hasMore, err)
	}
}
