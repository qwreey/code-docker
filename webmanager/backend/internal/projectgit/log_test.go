package projectgit

import (
	"errors"
	"os/exec"
	"testing"
)

func TestCommitInfo(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	head, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	full := string(head[:40])

	c, err := CommitInfo(dir, full[:7])
	if err != nil || c.Hash != full || c.Subject != "first" {
		t.Fatalf("abbreviated hash: got %+v, %v", c, err)
	}
	if _, err := CommitInfo(dir, "0000000"); !errors.Is(err, ErrUnknownCommit) {
		t.Fatalf("unknown hash: got %v, want ErrUnknownCommit", err)
	}
	if _, err := CommitInfo(dir, "--output=x"); !errors.Is(err, ErrInvalidHash) {
		t.Fatalf("flag-shaped hash: got %v, want ErrInvalidHash", err)
	}
}
