package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Encoding a non-UTF-8 file as a JSON string replaced every invalid byte
// with U+FFFD, so a one-character edit rewrote all of them on save.
func TestReadTextContentRefusesNonUTF8(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "cp949.txt")
	if err := os.WriteFile(path, []byte{0xc7, 0xd1, 0xb1, 0xdb, '\n'}, 0o644); err != nil { // "한글" in CP949
		t.Fatal(err)
	}
	if _, _, _, err := ReadTextContent(root, path); !errors.Is(err, ErrNotUTF8) {
		t.Fatalf("ReadTextContent(CP949) = %v, want ErrNotUTF8", err)
	}
}

func TestWriteTextContentRefusesAChangedFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "notes.md")
	writeFile(t, path, "v1")

	_, _, version, err := ReadTextContent(root, path)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "v1 plus an agent's edit")

	if _, err := WriteTextContent(root, path, "mine", version); !errors.Is(err, ErrChanged) {
		t.Fatalf("save over a changed file = %v, want ErrChanged", err)
	}
	if got := readFile(t, path); got != "v1 plus an agent's edit" {
		t.Fatalf("the other edit was overwritten: %q", got)
	}

	_, _, version, _ = ReadTextContent(root, path)
	next, err := WriteTextContent(root, path, "mine", version)
	if err != nil || readFile(t, path) != "mine" {
		t.Fatalf("save with the current version = %v", err)
	}
	// The version a save returns is the one to send with the next save.
	if _, err := WriteTextContent(root, path, "mine again", next); err != nil {
		t.Fatalf("second save with the returned version = %v", err)
	}
	// Empty: the user chose to overwrite.
	writeFile(t, path, "changed again")
	if _, err := WriteTextContent(root, path, "forced", ""); err != nil || readFile(t, path) != "forced" {
		t.Fatalf("unconditional save = %v", err)
	}
}
