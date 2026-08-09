package gitconfig

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrDefaultKeyExists is returned by GenerateSSHDefaultKey when a keypair
// already exists at keyPath — this generator is only for the "no key yet"
// first-run case, never a silent overwrite (unlike GenerateSSHSigningKey,
// which is an explicit "regenerate my signing key" action).
var ErrDefaultKeyExists = errors.New("default ssh key already exists")

// SSHDefaultKeyStatus reports whether the container's default outbound SSH
// identity (the plain ~/.ssh/id_ed25519 OpenSSH falls back to for any host
// with no explicit IdentityFile/Host block — e.g. plain `git clone
// git@github.com:...` with no SshHosts entry) already exists, and its public
// key if so.
func SSHDefaultKeyStatus(keyPath string) (exists bool, publicKey string, err error) {
	pubPath := keyPath + ".pub"
	pubData, err := os.ReadFile(pubPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", nil
		}
		return false, "", err
	}
	return true, strings.TrimSpace(string(pubData)), nil
}

// GenerateSSHDefaultKey creates the default identity keypair if (and only
// if) neither the private nor public key file exists yet at keyPath.
func GenerateSSHDefaultKey(keyPath string) (publicKey string, err error) {
	if _, err := os.Stat(keyPath); err == nil {
		return "", ErrDefaultKeyExists
	}
	if _, err := os.Stat(keyPath + ".pub"); err == nil {
		return "", ErrDefaultKeyExists
	}

	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}

	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "webmanager-default-key")
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
