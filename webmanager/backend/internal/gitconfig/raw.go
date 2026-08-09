package gitconfig

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrInvalidGitConfigSyntax distinguishes a genuine "the content you
// submitted doesn't parse" rejection from an I/O failure (disk full,
// permission denied) elsewhere in WriteRaw - callers previously mapped
// every WriteRaw error to 400, which reported a real server-side I/O
// problem as if it were bad user input. See root CLAUDE.md's code-quality
// audit.
var ErrInvalidGitConfigSyntax = errors.New("invalid git config syntax")

// ReadRaw returns the raw contents of the gitconfig file at path, for the
// web-based raw editor. A missing file reads as "" rather than erroring,
// mirroring the empty-value defaults elsewhere in this package.
func ReadRaw(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteRaw validates content as git-config syntax before touching the real
// file: it's written to a temp file in the same directory first, then
// `git config -f <tempfile> -l` is run to parse it (this fails loudly on
// syntax errors; unlike --get/--list-style lookups it doesn't require any
// particular key to exist, so an empty or key-less file still passes). Only
// on success is the temp file atomically moved over path via os.Rename,
// which is safe because both live on the same filesystem (same directory).
// This protects the user from a typo in raw-edit mode breaking every git
// operation in the container until they notice.
func WriteRaw(path, content string) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".gitconfig.tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below succeeds

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	out, err := exec.Command("git", "config", "-f", tmpPath, "-l").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidGitConfigSyntax, strings.TrimSpace(string(out)))
	}

	return os.Rename(tmpPath, path)
}
