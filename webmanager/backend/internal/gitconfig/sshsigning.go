package gitconfig

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// GenerateSSHSigningKey (re)generates the dedicated ed25519 keypair webmanager
// offers for SSH-based commit signing, mirroring the ssh-keygen invocation in
// sshhosts.go's AddSSHHost. keyPath is a fixed location (SSH_SIGNING_KEY_PATH)
// — regenerating overwrites any previous keypair there, which is expected.
// Any existing files at keyPath are removed first: ssh-keygen prompts to
// confirm an overwrite interactively, which would otherwise fail (stdin is
// not a terminal here) instead of overwriting.
func GenerateSSHSigningKey(keyPath string) (publicKeyPath, publicKey string, err error) {
	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", "", err
	}

	pubPath := keyPath + ".pub"
	_ = os.Remove(keyPath)
	_ = os.Remove(pubPath)

	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "webmanager-signing-key")
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("ssh-keygen: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return "", "", err
	}
	if err := os.Chmod(pubPath, 0o644); err != nil {
		return "", "", err
	}

	pubData, err := os.ReadFile(pubPath)
	if err != nil {
		return "", "", err
	}
	return pubPath, strings.TrimSpace(string(pubData)), nil
}
