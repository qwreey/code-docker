package gitconfig

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ReadRawSSHConfig returns the raw contents of the ssh_config file at path,
// for the web-based raw editor (advanced Host/Match/ProxyJump editing beyond
// what the structured SshHosts panel understands). A missing file reads as
// "" rather than erroring, mirroring ReadRaw in raw.go.
func ReadRawSSHConfig(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteRawSSHConfig validates content as ssh_config syntax before touching
// the real file, mirroring WriteRaw's git-config validation in raw.go: it's
// written to a temp file in the same directory first, then `ssh -F <tempfile>
// -G placeholder-host` is run to have OpenSSH itself parse it and print the
// effective configuration (no network connection is attempted — -G only
// resolves Host/Match blocks). This fails loudly on a malformed directive
// instead of silently saving a broken config that could break every
// outbound ssh/git-over-ssh connection in the container until noticed. Only
// on success is the temp file atomically moved over path via os.Rename.
func WriteRawSSHConfig(path, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".ssh-config.tmp-*")
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
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}

	out, err := exec.Command("ssh", "-F", tmpPath, "-G", "webmanager-ssh-config-validation").CombinedOutput()
	if err != nil {
		return fmt.Errorf("invalid ssh config syntax: %s", strings.TrimSpace(string(out)))
	}

	return os.Rename(tmpPath, path)
}
