package logstore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func line(ts time.Time, app, msg string) string {
	return fmt.Sprintf(`{"timestamp":%q,"app_name":%q,"level":"info","message":%q}`+"\n", ts.UTC().Format(time.RFC3339Nano), app, msg)
}

func writeDay(t *testing.T, dir string, day time.Time, content string) string {
	t.Helper()
	path := filepath.Join(dir, day.UTC().Format(dateFileLayout)+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadEntriesPagesNewestFirstAcrossDays(t *testing.T) {
	dir := t.TempDir()
	today := time.Now().UTC().Truncate(24 * time.Hour).Add(12 * time.Hour)
	var b strings.Builder
	for i := range 50 {
		b.WriteString(line(today.Add(time.Duration(i)*time.Second), "a", fmt.Sprint(i)))
	}
	writeDay(t, dir, today, b.String())
	writeDay(t, dir, today.AddDate(0, 0, -1), line(today.AddDate(0, 0, -1), "a", "yesterday"))

	got, more, err := ReadEntries(dir, "", "", 0, 0, 0, 10)
	if err != nil || !more || len(got) != 10 || got[0].Message != "49" || got[9].Message != "40" {
		t.Fatalf("first page = %v %v %v", got, more, err)
	}
	got, more, _ = ReadEntries(dir, "", "", 0, 0, got[9].Timestamp, 100)
	if more || len(got) != 41 || got[39].Message != "0" || got[40].Message != "yesterday" {
		t.Fatalf("second page = %d entries, more=%v, last=%v", len(got), more, got[len(got)-1])
	}
}

// A line over the read buffer used to stop the read, hiding the rest of
// the day.
func TestReadEntriesGoesOnAfterAnOverlongLine(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	writeDay(t, dir, now, line(now.Add(-2*time.Second), "a", "before")+
		line(now.Add(-time.Second), "a", strings.Repeat("x", maxLineBytes+10))+
		line(now, "a", "after"))
	got, _, err := ReadEntries(dir, "", "", 0, 0, 0, 10)
	if err != nil || len(got) != 2 || got[0].Message != "after" || got[1].Message != "before" {
		t.Fatalf("entries around an overlong line: %d entries, err %v", len(got), err)
	}
}

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

// vector keeps today's file open; replacing it sent later lines to an
// unlinked inode.
func TestPurgeKeepsTheFileVectorWritesTo(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	path := writeDay(t, dir, now, line(now, "noisy", "drop")+line(now, "keep", "kept")+"not json\n")
	before := inode(t, path)

	if err := PurgeApp(dir, "noisy"); err != nil {
		t.Fatal(err)
	}
	if inode(t, path) != before {
		t.Fatal("PurgeApp replaced a file vector may have open")
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "drop") || !strings.Contains(string(b), "kept") || !strings.Contains(string(b), "not json") {
		t.Fatalf("after purge: %q", b)
	}

	if err := PurgeDate(dir, now.Format(dateFileLayout)); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Size() != 0 || inode(t, path) != before {
		t.Fatalf("PurgeDate on an open file should empty it in place: %v %v", info, err)
	}
}

func TestPurgeReplacesAndRemovesOldFiles(t *testing.T) {
	dir := t.TempDir()
	day := time.Now().UTC().AddDate(0, 0, -3)
	path := writeDay(t, dir, day, line(day, "noisy", "drop")+line(day, "keep", "kept"))
	old := time.Now().Add(-time.Hour)
	os.Chtimes(path, old, old)

	if err := PurgeApp(dir, "noisy"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "drop") || !strings.Contains(string(b), "kept") {
		t.Fatalf("after purge: %q", b)
	}
	os.Chtimes(path, old, old)
	if err := PurgeDate(dir, day.Format(dateFileLayout)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("old day-file not removed: %v", err)
	}
}
