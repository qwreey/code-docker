package gitconfig

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrInvalidSSHConfigSyntax distinguishes a genuine "the content you
// submitted is rejected" error (a Match exec block, or a malformed
// directive `ssh -G` itself rejects) from an I/O failure elsewhere in
// WriteRawSSHConfig - see raw.go's identical ErrInvalidGitConfigSyntax for
// the full reasoning.
var ErrInvalidSSHConfigSyntax = errors.New("invalid ssh config")

// matchExecRe catches an ssh_config `Match ... exec "command"` criterion.
// OpenSSH's `-G` (used below to validate syntax) fully evaluates Match
// blocks to compute the effective config, which means it actually RUNS an
// exec criterion's command - not just parses it. That turns "validate this
// before saving" into arbitrary command execution the moment someone pastes
// in an untrusted snippet, even if the save is never confirmed. Confirmed
// live in this environment: a `Match exec "touch ..."` block creates the
// file as a side effect of validation alone. Reject rather than evaluate.
var matchExecRe = regexp.MustCompile(`(?im)^\s*match\b.*\bexec\b`)

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
	if matchExecRe.MatchString(content) {
		return fmt.Errorf("%w: 'Match exec' is not supported here - validating it would execute the command it names", ErrInvalidSSHConfigSyntax)
	}

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
		return fmt.Errorf("%w: %s", ErrInvalidSSHConfigSyntax, strings.TrimSpace(string(out)))
	}

	return os.Rename(tmpPath, path)
}
