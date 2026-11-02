package claudememory

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const testProject = "/code/Projects/app"

func memoryDir(t *testing.T, configDir string) string {
	t.Helper()
	dir := filepath.Join(configDir, projectsDirName, ProjectSlug(testProject), memorySubdir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestLoadReadsNotes(t *testing.T) {
	configDir := t.TempDir()
	dir := memoryDir(t, configDir)
	write(t, filepath.Join(dir, indexFileName), "- [Note](note.md) — hook\n")
	write(t, filepath.Join(dir, "note.md"), "---\nname: note\n---\nbody\n")

	mem, err := Load(configDir, testProject)
	if err != nil {
		t.Fatal(err)
	}
	if !mem.Exists || len(mem.Index) != 1 || len(mem.Files) != 1 || mem.Files[0].Name != "note" {
		t.Fatalf("unexpected memory: %+v", mem)
	}
}

func TestLoadMissingIsEmptyNotError(t *testing.T) {
	for _, configDir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "absent")} {
		mem, err := Load(configDir, testProject)
		if err != nil {
			t.Fatalf("%s: %v", configDir, err)
		}
		if mem.Exists || mem.Index == nil || mem.Files == nil {
			t.Fatalf("%s: want empty non-nil memory, got %+v", configDir, mem)
		}
	}
}

// A planted link must not turn the viewer into a read of a file outside the
// projects directory, whichever way the link is spelled.
func TestLoadDoesNotFollowLinksOutside(t *testing.T) {
	configDir := t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret")
	write(t, secret, "TOP-SECRET")
	dir := memoryDir(t, configDir)
	symlink(t, secret, filepath.Join(dir, indexFileName))
	symlink(t, secret, filepath.Join(dir, "absolute.md"))
	rel, err := filepath.Rel(dir, secret)
	if err != nil {
		t.Fatal(err)
	}
	symlink(t, rel, filepath.Join(dir, "relative.md"))

	mem, err := Load(configDir, testProject)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mem.IndexRaw, "TOP-SECRET") || len(mem.Files) != 0 {
		t.Fatalf("read through a link: %+v", mem)
	}
}

func TestLoadRefusesMemoryDirLinkedOutside(t *testing.T) {
	configDir := t.TempDir()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "note.md"), "TOP-SECRET")
	dir := memoryDir(t, configDir)
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	symlink(t, outside, dir)

	if mem, err := Load(configDir, testProject); err == nil {
		t.Fatalf("want an error, got %+v", mem)
	}
}

func TestLoadSkipsFIFOAndOversizedFiles(t *testing.T) {
	configDir := t.TempDir()
	dir := memoryDir(t, configDir)
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "huge.md"), strings.Repeat("x", maxMemoryFileSize+1))
	write(t, filepath.Join(dir, "fits.md"), strings.Repeat("x", maxMemoryFileSize))

	done := make(chan Memory, 1)
	go func() {
		mem, err := Load(configDir, testProject)
		if err != nil {
			t.Error(err)
		}
		done <- mem
	}()
	select {
	case mem := <-done:
		if len(mem.Files) != 1 || mem.Files[0].Filename != "fits.md" {
			t.Fatalf("want only fits.md, got %d files", len(mem.Files))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Load hung on a FIFO")
	}
}
