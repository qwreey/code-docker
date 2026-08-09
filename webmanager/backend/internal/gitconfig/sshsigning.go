package gitconfig

import (
	"os"
	"path/filepath"
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

	pub, err := generateEd25519Key(keyPath, "webmanager-signing-key")
	if err != nil {
		return "", "", err
	}
	return pubPath, pub, nil
}
