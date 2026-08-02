// Package sshkeys manages an authorized_keys file: parsing entries,
// appending new ones, and removing them by a stable derived id.
package sshkeys

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/ssh"
)

type Key struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Comment     string `json:"comment"`
	Fingerprint string `json:"fingerprint"`
	Raw         string `json:"raw"`
}

var (
	ErrInvalidKey = errors.New("not a valid ssh public key")
	ErrDuplicate  = errors.New("key already exists")
	ErrNotFound   = errors.New("key not found")
)

// id is derived from the key material only (not the comment/options), so
// re-adding the same key with a different comment is still a duplicate.
func computeID(pub ssh.PublicKey) string {
	sum := sha256.Sum256(pub.Marshal())
	return hex.EncodeToString(sum[:])
}

func parseLine(line string) (Key, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return Key{}, false
	}
	pub, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(trimmed))
	if err != nil {
		return Key{}, false
	}
	return Key{
		ID:          computeID(pub),
		Type:        pub.Type(),
		Comment:     comment,
		Fingerprint: ssh.FingerprintSHA256(pub),
		Raw:         trimmed,
	}, true
}

func List(path string) ([]Key, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Key{}, nil
		}
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	keys := make([]Key, 0, len(lines))
	for _, line := range lines {
		if k, ok := parseLine(line); ok {
			keys = append(keys, k)
		}
	}
	return keys, nil
}

func Add(path, keyLine string) (Key, error) {
	k, ok := parseLine(keyLine)
	if !ok {
		return Key{}, ErrInvalidKey
	}

	existing, err := List(path)
	if err != nil {
		return Key{}, err
	}
	for _, e := range existing {
		if e.ID == k.ID {
			return Key{}, ErrDuplicate
		}
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Key{}, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return Key{}, err
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return Key{}, err
	}
	defer f.Close()
	if _, err := f.WriteString(k.Raw + "\n"); err != nil {
		return Key{}, err
	}
	if err := f.Chmod(0o600); err != nil {
		return Key{}, err
	}

	return k, nil
}

// Delete rewrites the file line-by-line, dropping only the line whose
// parsed id matches. Non-key lines (comments, blank lines, entries that
// fail to parse) are preserved verbatim.
func Delete(path, id string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}

	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	found := false
	for _, line := range lines {
		if k, ok := parseLine(line); ok && k.ID == id {
			found = true
			continue
		}
		kept = append(kept, line)
	}
	if !found {
		return ErrNotFound
	}

	content := strings.Join(kept, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
