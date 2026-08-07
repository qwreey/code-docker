package gitconfig

import (
	"os"
	"testing"
)

func TestAddKnownHostRejectsMultilineInjection(t *testing.T) {
	malicious := "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3fake1fake1fake1fake1fake1fake1fake1fake1fake\nevil.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3fake2fake2fake2fake2fake2fake2fake2fake2fake"
	path := t.TempDir() + "/known_hosts"
	err := AddKnownHost(path, malicious)
	if err == nil {
		t.Fatalf("AddKnownHost(multiline) = nil error, want ErrInvalidKnownHost")
	}
	data, _ := os.ReadFile(path)
	if len(data) != 0 {
		t.Fatalf("file should be empty after rejected AddKnownHost, got %q", string(data))
	}
}
