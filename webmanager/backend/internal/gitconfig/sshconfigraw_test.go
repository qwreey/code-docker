package gitconfig

import (
	"os"
	"path/filepath"
	"testing"
)

// TestWriteRawSSHConfigRejectsMatchExec guards against a real bug: `-G`
// (used to validate syntax) fully evaluates Match blocks, so a `Match exec
// "cmd"` criterion actually runs cmd as a side effect of validation alone,
// regardless of whether the content is ultimately saved. Confirmed live: a
// `touch` command inside such a block created a file purely from calling
// WriteRawSSHConfig, before this guard existed.
func TestWriteRawSSHConfigRejectsMatchExec(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	marker := filepath.Join(dir, "PWNED")
	content := "Match exec \"touch " + marker + "\"\n    HostName example.com\n"

	err := WriteRawSSHConfig(path, content)
	if err == nil {
		t.Fatalf("WriteRawSSHConfig(Match exec) = nil error, want rejection")
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatalf("Match exec command executed as a side effect of validation - marker file was created")
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Fatalf("rejected content was written to path")
	}
}

func TestWriteRawSSHConfigAcceptsValidConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	content := "Host example\n    HostName example.com\n    User git\n"

	if err := WriteRawSSHConfig(path, content); err != nil {
		t.Fatalf("WriteRawSSHConfig(valid config) = %v, want success", err)
	}
	got, err := ReadRawSSHConfig(path)
	if err != nil {
		t.Fatalf("ReadRawSSHConfig() = %v", err)
	}
	if got != content {
		t.Fatalf("ReadRawSSHConfig() = %q, want %q", got, content)
	}
}

func TestWriteRawSSHConfigRejectsMalformedSyntax(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	// "HostName" outside any Host/Match block, with a bare unterminated
	// quote - ssh -G should still reject this on its own merits.
	content := "HostName \"unterminated\n"

	if err := WriteRawSSHConfig(path, content); err == nil {
		t.Fatalf("WriteRawSSHConfig(malformed) = nil error, want a syntax error")
	}
}
