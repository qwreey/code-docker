// Package atomicfile provides a crash-safe file write (temp file in the
// same directory + rename) for the config/credential files various
// webmanager packages read-modify-write. internal/claudecode/prefs.go and
// internal/terminalsettings already did this by hand for their own files;
// this pulls the same pattern out for internal/sshkeys and
// internal/gitconfig, which previously wrote via a plain os.WriteFile - a
// crash mid-write there could leave a truncated authorized_keys/.gitconfig/
// known_hosts file behind (in sshkeys' case, a potential SSH lockout).
package atomicfile

import (
	"os"
	"path/filepath"
)

// Write atomically replaces path's contents with data: MkdirAll the parent
// directory (dirPerm), write to a same-directory temp file (perm), then
// rename over path. The temp file uses a fixed name (not
// os.CreateTemp's random suffix) since callers are expected to serialize
// writes to the same path themselves (e.g. a package-level sync.Mutex) -
// see each caller's own comment.
func Write(path string, data []byte, perm, dirPerm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	// os.WriteFile only applies perm when it CREATES the file - if a
	// previous crash left a stale .tmp file with different permissions
	// behind, WriteFile's O_TRUNC reuses that file as-is and perm is
	// silently ignored. Explicit Chmod guarantees the file this renames
	// over path always ends up with exactly perm, which matters for the
	// credential-bearing callers (authorized_keys, tinyauth users) that
	// pass 0o600.
	if err := os.Chmod(tmp, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
