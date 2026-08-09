package gitconfig

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// generateEd25519Key runs `ssh-keygen -t ed25519` at keyPath with comment,
// then chmods and reads back the resulting public key - the common tail end
// of AddSSHHost (sshhosts.go), GenerateSSHSigningKey (sshsigning.go), and
// GenerateSSHDefaultKey (sshdefaultkey.go), which otherwise each
// reimplemented the same five steps. Callers remain responsible for
// anything before this (MkdirAll/chmod the parent dir, an existence check
// or pre-emptive removal of a previous keypair) since that policy differs
// per caller.
func generateEd25519Key(keyPath, comment string) (publicKey string, err error) {
	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", comment)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("ssh-keygen: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return "", err
	}
	if err := os.Chmod(keyPath+".pub", 0o644); err != nil {
		return "", err
	}
	pubData, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(pubData)), nil
}
