package atomicfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteCreatesFileAndParentDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", "file.txt")
	if err := Write(path, []byte("hello"), 0o644, 0o755); err != nil {
		t.Fatalf("Write() = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() = %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("content = %q, want %q", got, "hello")
	}
	// no leftover temp file
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temp file left behind: err=%v", err)
	}
}

func TestWriteOverwritesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.txt")
	if err := Write(path, []byte("v1"), 0o644, 0o755); err != nil {
		t.Fatalf("Write(v1) = %v", err)
	}
	if err := Write(path, []byte("v2"), 0o644, 0o755); err != nil {
		t.Fatalf("Write(v2) = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() = %v", err)
	}
	if string(got) != "v2" {
		t.Fatalf("content = %q, want %q", got, "v2")
	}
}

// TestWriteFixesStaleTempFilePermissions guards a real edge case: a crash
// between a previous Write's temp-file creation and its rename can leave a
// .tmp file behind with permissions from an earlier, differently-permed
// attempt. os.WriteFile alone only applies its perm argument when it
// creates a file - reusing an existing .tmp via O_TRUNC leaves its mode
// untouched - so without an explicit Chmod, that stale mode would silently
// survive the rename onto path, which matters for a 0o600 credential file
// like the tailscale/netgate config or tinyauth's users file.
func TestWriteFixesStaleTempFilePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path+".tmp", []byte("stale"), 0o644); err != nil {
		t.Fatalf("seeding stale temp file: %v", err)
	}

	if err := Write(path, []byte("real content"), 0o600, 0o700); err != nil {
		t.Fatalf("Write() = %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("final file mode = %v, want 0600 (stale .tmp permissions leaked through)", info.Mode().Perm())
	}
}
