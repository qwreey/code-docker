package authgate

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// storedHash is the on-disk shape written by writeStoredHash - just the
// encoded argon2id hash, same format HashPassword produces. A struct
// (rather than the bare string) leaves room to add fields later (e.g. a
// changed-at timestamp) without an on-disk format migration.
type storedHash struct {
	Hash string `json:"hash"`
}

// readStoredHash reads the hash persisted by SetupPassword/ChangePassword.
// A missing file resolves to ("", nil) - not configured yet, not an error -
// since this is the normal state before first setup.
func readStoredHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var v storedHash
	if err := json.Unmarshal(data, &v); err != nil {
		return "", err
	}
	return v.Hash, nil
}

// writeStoredHash persists hash atomically (temp file + rename) so a crash
// mid-write can't leave a corrupt/partial file behind - same pattern used
// elsewhere in this repo for backend-persisted JSON (e.g. webmanager's
// internal/terminalsettings). 0o600 since this is a credential.
func writeStoredHash(path, hash string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(storedHash{Hash: hash})
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
