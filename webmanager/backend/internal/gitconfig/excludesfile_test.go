package gitconfig

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestReadExcludesFile(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "ignore")
	if err := os.WriteFile(plain, []byte("*.log\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Dotfile managers link this file, so a symlink has to keep working.
	link := filepath.Join(dir, "link")
	if err := os.Symlink(plain, link); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{plain, link} {
		got, err := ReadExcludesFile(p)
		if err != nil || got != "*.log\n" {
			t.Errorf("%s: got %q, %v", p, got, err)
		}
	}
	if got, err := ReadExcludesFile(filepath.Join(dir, "absent")); err != nil || got != "" {
		t.Errorf("absent file: got %q, %v", got, err)
	}
}

func TestReadExcludesFileRefusesOversized(t *testing.T) {
	dir := t.TempDir()
	huge := filepath.Join(dir, "huge")
	if err := os.WriteFile(huge, []byte(strings.Repeat("x", maxExcludesFileSize+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadExcludesFile(huge); err == nil {
		t.Error("oversized file was read")
	}
	fits := filepath.Join(dir, "fits")
	if err := os.WriteFile(fits, []byte(strings.Repeat("x", maxExcludesFileSize)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadExcludesFile(fits); err != nil {
		t.Errorf("file at the limit: %v", err)
	}
}

// These used to hang the request or exhaust memory.
func TestReadExcludesFileRefusesNonRegular(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{fifo, "/dev/zero", dir} {
		done := make(chan error, 1)
		go func() {
			_, err := ReadExcludesFile(p)
			done <- err
		}()
		select {
		case err := <-done:
			if err == nil {
				t.Errorf("%s: was read", p)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: read hung", p)
		}
	}
}
