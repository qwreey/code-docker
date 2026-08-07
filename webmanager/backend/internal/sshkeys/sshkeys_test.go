package sshkeys

import (
	"os"
	"testing"
)

func TestAddRejectsMultilineInjection(t *testing.T) {
	malicious := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3fake1fake1fake1fake1fake1fake1fake1fake1fake valid\ncommand=\"/bin/backdoor\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3fake2fake2fake2fake2fake2fake2fake2fake2fake evil"
	path := t.TempDir() + "/authorized_keys"
	k, err := Add(path, malicious)
	if err == nil {
		t.Fatalf("Add(multiline) = %+v, want ErrInvalidKey", k)
	}
	data, _ := os.ReadFile(path)
	if len(data) != 0 {
		t.Fatalf("file should be empty after rejected Add, got %q", string(data))
	}
}
