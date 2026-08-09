package gitconfig

import (
	"os"
	"strings"
	"testing"
)

// TestUpsertCredentialRejectsNewlineInHost is defense-in-depth: net/url's
// own Host encoder already percent-encodes \n/\r (confirmed empirically),
// so this isn't currently reachable as a real line-injection into
// credsPath, but every sibling parser in this package (knownhosts.go,
// sshhosts.go) rejects this outright rather than relying on stdlib
// encoding behavior as the only defense - this keeps credentials.go
// consistent with that and guards against a future refactor accidentally
// removing the implicit protection.
func TestUpsertCredentialRejectsNewlineInHost(t *testing.T) {
	dir := t.TempDir()
	credsPath := dir + "/credentials"
	gitConfigPath := dir + "/.gitconfig"

	_, err := UpsertCredential(credsPath, gitConfigPath, "evil.com\nFakeHost: injected", "user", "token")
	if err == nil {
		t.Fatalf("UpsertCredential(host with newline) = nil error, want rejection")
	}
	if data, statErr := os.ReadFile(credsPath); statErr == nil && len(data) != 0 {
		t.Fatalf("credentials file should not exist/be empty after rejected UpsertCredential, got %q", string(data))
	}
}

func TestUpsertCredentialThenList(t *testing.T) {
	dir := t.TempDir()
	credsPath := dir + "/credentials"
	gitConfigPath := dir + "/.gitconfig"

	if _, err := UpsertCredential(credsPath, gitConfigPath, "github.com", "alice", "secret-token"); err != nil {
		t.Fatalf("UpsertCredential() = %v", err)
	}

	creds, err := ListCredentials(credsPath)
	if err != nil {
		t.Fatalf("ListCredentials() = %v", err)
	}
	if len(creds) != 1 || creds[0].Host != "github.com" || creds[0].Username != "alice" {
		t.Fatalf("ListCredentials() = %+v, want one entry for github.com/alice", creds)
	}

	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("ReadFile() = %v", err)
	}
	if !strings.Contains(string(data), "secret-token") {
		t.Fatalf("credentials file missing token: %q", string(data))
	}
}
