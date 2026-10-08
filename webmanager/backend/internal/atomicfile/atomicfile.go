// Package atomicfile provides a crash-safe file write (temp file in the
// same directory + rename) for the config/credential/state files webmanager
// packages write. A crash mid-write can't leave a truncated file behind (in
// sshkeys' case that would be a potential SSH lockout), and a reader never
// sees a half-written one.
package atomicfile

import (
	"os"
	"path/filepath"
)

// Write atomically replaces path's contents with data: MkdirAll the parent
// directory (dirPerm), write to a uniquely named temp file in the same
// directory, give it perm, then rename over path. The unique name means two
// writers can't trample each other's temp file; serializing a
// read-modify-write of the same file is still the caller's job.
func Write(path string, data []byte, perm, dirPerm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(name)
		return writeErr
	}
	if closeErr != nil {
		os.Remove(name)
		return closeErr
	}
	// os.CreateTemp creates 0o600; perm matters both ways - 0o600 for the
	// credential-bearing callers (authorized_keys, tinyauth users), wider
	// for files other programs read.
	if err := os.Chmod(name, perm); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}
