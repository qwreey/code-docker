package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// The copy dialog defaults to the current folder. Copying there used to
// truncate the source before reading it and report success.
func TestCopyIntoOwnFolderMakesACopy(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "report.txt"), "original")
	writeFile(t, filepath.Join(root, "proj", "a.go"), "package a")

	for range 2 {
		res := Copy(root, []string{filepath.Join(root, "report.txt"), filepath.Join(root, "proj")}, root, false)
		for _, r := range res {
			if !r.Ok {
				t.Fatalf("Copy into own folder: %+v", r)
			}
		}
	}
	if got := readFile(t, filepath.Join(root, "report.txt")); got != "original" {
		t.Fatalf("source changed to %q", got)
	}
	for _, p := range []string{"report (copy).txt", "report (copy 2).txt", "proj (copy)/a.go", "proj (copy 2)/a.go"} {
		readFile(t, filepath.Join(root, p))
	}
	if got := readFile(t, filepath.Join(root, "proj", "a.go")); got != "package a" {
		t.Fatalf("source tree changed: %q", got)
	}
}

func TestCopyOrMoveIntoItselfIsRefused(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "p", "sub", "f"), "x")
	for name, op := range map[string]func([]string, string, bool) []ItemResult{
		"copy": func(i []string, d string, o bool) []ItemResult { return Copy(root, i, d, o) },
		"move": func(i []string, d string, o bool) []ItemResult { return Move(root, i, d, o) },
	} {
		res := op([]string{filepath.Join(root, "p")}, filepath.Join(root, "p", "sub"), true)
		if res[0].Ok || res[0].Error != ErrIntoItself.Error() {
			t.Fatalf("%s into own subfolder = %+v, want ErrIntoItself", name, res[0])
		}
	}
}

func TestExistingDestinationNeedsOverwrite(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a", "f.txt"), "new")
	writeFile(t, filepath.Join(root, "b", "f.txt"), "old")
	writeFile(t, filepath.Join(root, "b", "g.txt"), "keep")

	res := Copy(root, []string{filepath.Join(root, "a", "f.txt")}, filepath.Join(root, "b"), false)
	if res[0].Ok || !res[0].Exists {
		t.Fatalf("Copy onto existing = %+v, want Exists", res[0])
	}
	res = Move(root, []string{filepath.Join(root, "a", "f.txt")}, filepath.Join(root, "b"), false)
	if res[0].Ok || !res[0].Exists {
		t.Fatalf("Move onto existing = %+v, want Exists", res[0])
	}
	if err := Rename(root, filepath.Join(root, "b", "g.txt"), "f.txt", false); !errors.Is(err, ErrExists) {
		t.Fatalf("Rename onto existing = %v, want ErrExists", err)
	}
	if got := readFile(t, filepath.Join(root, "b", "f.txt")); got != "old" {
		t.Fatalf("destination replaced without overwrite: %q", got)
	}

	res = Copy(root, []string{filepath.Join(root, "a", "f.txt")}, filepath.Join(root, "b"), true)
	if !res[0].Ok || readFile(t, filepath.Join(root, "b", "f.txt")) != "new" {
		t.Fatalf("Copy with overwrite = %+v", res[0])
	}
	if err := Rename(root, filepath.Join(root, "b", "g.txt"), "f.txt", true); err != nil || readFile(t, filepath.Join(root, "b", "f.txt")) != "keep" {
		t.Fatalf("Rename with overwrite = %v", err)
	}
}

func TestUploadKeepsTheOldFileUntilCommit(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "report.docx")
	writeFile(t, dest, "old")
	if err := os.Chmod(dest, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := StartUpload(root, root, "report.docx", false); !errors.Is(err, ErrExists) {
		t.Fatalf("StartUpload onto existing = %v, want ErrExists", err)
	}

	// A transfer cut off half way.
	u, err := StartUpload(root, root, "report.docx", true)
	if err != nil {
		t.Fatal(err)
	}
	u.WriteString("half")
	u.Abort()
	if got := readFile(t, dest); got != "old" {
		t.Fatalf("aborted upload changed the file: %q", got)
	}

	u, err = StartUpload(root, root, "report.docx", true)
	if err != nil {
		t.Fatal(err)
	}
	u.WriteString("new")
	if err := u.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dest); got != "new" {
		t.Fatalf("committed upload = %q", got)
	}
	if info, _ := os.Stat(dest); info.Mode().Perm() != 0o600 {
		t.Fatalf("overwrite changed the mode to %v", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}
