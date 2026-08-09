package gitconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"webmanager/internal/atomicfile"
)

// sshHostsMu serializes read-modify-write access to configPath - see
// internal/sshkeys' identical mu for why.
var sshHostsMu sync.Mutex

type SSHHost struct {
	Host         string `json:"host"`
	HostName     string `json:"hostname"`
	User         string `json:"user"`
	IdentityFile string `json:"identityFile"`
	PublicKey    string `json:"publicKey"`
}

var (
	ErrHostExists   = errors.New("host already exists")
	ErrHostNotFound = errors.New("host not found")
	// ErrInvalidHost is returned when host/hostname/user fail validation in
	// AddSSHHost, before any file is touched. host must be safe to use as
	// both a filesystem path component (filepath.Join(keysDir, host)) and an
	// SSH config "Host" alias, so it's restricted to a conservative charset;
	// hostname/user only need to be safe against SSH-config-line injection
	// (a newline would let them start a bogus new directive/Host block), so
	// they're checked for CR/LF only.
	ErrInvalidHost = errors.New("invalid host, hostname, or user")
)

var hostLineRe = regexp.MustCompile(`(?i)^\s*Host\s+(\S+)\s*$`)

// validHostRe restricts host to characters that are safe as both a
// filesystem path component and an SSH config alias — this excludes "/",
// "\", "..", whitespace, and anything else that could let host escape
// keysDir (path traversal) or break out of its "Host %s" config line.
var validHostRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func validateAddSSHHostInput(host, hostname, user string) error {
	if host == "" || !validHostRe.MatchString(host) {
		return ErrInvalidHost
	}
	if strings.ContainsAny(hostname, "\r\n") || strings.ContainsAny(user, "\r\n") {
		return ErrInvalidHost
	}
	return nil
}

// sshConfigBlock is one "Host x" section plus its raw body lines. The first
// block (host == "") is any preamble before the first Host line. Body lines
// are kept verbatim so directives webmanager doesn't understand survive
// round-tripping through Add/Delete.
type sshConfigBlock struct {
	host  string
	lines []string
}

func parseSSHConfig(path string) ([]sshConfigBlock, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	lines := strings.Split(string(data), "\n")
	var blocks []sshConfigBlock
	current := sshConfigBlock{host: ""}
	for _, line := range lines {
		if m := hostLineRe.FindStringSubmatch(line); m != nil {
			blocks = append(blocks, current)
			current = sshConfigBlock{host: m[1]}
			continue
		}
		current.lines = append(current.lines, line)
	}
	blocks = append(blocks, current)
	return blocks, nil
}

func extractField(lines []string, key string) string {
	re := regexp.MustCompile(`(?i)^\s*` + regexp.QuoteMeta(key) + `\s+(.+?)\s*$`)
	for _, l := range lines {
		if m := re.FindStringSubmatch(l); m != nil {
			return strings.Trim(m[1], `"`)
		}
	}
	return ""
}

func ListSSHHosts(configPath string) ([]SSHHost, error) {
	blocks, err := parseSSHConfig(configPath)
	if err != nil {
		return nil, err
	}
	out := make([]SSHHost, 0, len(blocks))
	for _, b := range blocks {
		if b.host == "" {
			continue
		}
		identityFile := extractField(b.lines, "IdentityFile")
		pub := ""
		if identityFile != "" {
			if data, err := os.ReadFile(identityFile + ".pub"); err == nil {
				pub = strings.TrimSpace(string(data))
			}
		}
		out = append(out, SSHHost{
			Host:         b.host,
			HostName:     extractField(b.lines, "HostName"),
			User:         extractField(b.lines, "User"),
			IdentityFile: identityFile,
			PublicKey:    pub,
		})
	}
	return out, nil
}

func AddSSHHost(configPath, keysDir, host, hostname, user string) (SSHHost, error) {
	if err := validateAddSSHHostInput(host, hostname, user); err != nil {
		return SSHHost{}, err
	}

	sshHostsMu.Lock()
	defer sshHostsMu.Unlock()

	existing, err := ListSSHHosts(configPath)
	if err != nil {
		return SSHHost{}, err
	}
	for _, h := range existing {
		if h.Host == host {
			return SSHHost{}, ErrHostExists
		}
	}

	if err := os.MkdirAll(keysDir, 0o700); err != nil {
		return SSHHost{}, err
	}
	if err := os.Chmod(keysDir, 0o700); err != nil {
		return SSHHost{}, err
	}

	// keyPath is safe to join directly: validateAddSSHHostInput already
	// rejected anything but [A-Za-z0-9._-] in host, so this can't escape
	// keysDir.
	keyPath := filepath.Join(keysDir, host)
	pubKey, err := generateEd25519Key(keyPath, fmt.Sprintf("webmanager@%s", host))
	if err != nil {
		return SSHHost{}, err
	}

	// From here on, the key files exist on disk — any failure must clean
	// them up before returning, so a retry doesn't get stuck on
	// ssh-keygen's own interactive overwrite prompt (mirrors
	// GenerateSSHSigningKey's pre-emptive removal in sshsigning.go).
	cleanupKeyFiles := func() {
		_ = os.Remove(keyPath)
		_ = os.Remove(keyPath + ".pub")
	}

	block := fmt.Sprintf("\nHost %s\n    HostName %s\n    User %s\n    IdentityFile %s\n", host, hostname, user, keyPath)
	existingData, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		cleanupKeyFiles()
		return SSHHost{}, err
	}
	if err := atomicfile.Write(configPath, append(existingData, []byte(block)...), 0o644, 0o755); err != nil {
		cleanupKeyFiles()
		return SSHHost{}, err
	}

	return SSHHost{
		Host:         host,
		HostName:     hostname,
		User:         user,
		IdentityFile: keyPath,
		PublicKey:    pubKey,
	}, nil
}

func DeleteSSHHost(configPath, host string) error {
	sshHostsMu.Lock()
	defer sshHostsMu.Unlock()

	blocks, err := parseSSHConfig(configPath)
	if err != nil {
		return err
	}

	found := false
	var identityFile string
	kept := make([]sshConfigBlock, 0, len(blocks))
	for _, b := range blocks {
		if b.host == host {
			found = true
			identityFile = extractField(b.lines, "IdentityFile")
			continue
		}
		kept = append(kept, b)
	}
	if !found {
		return ErrHostNotFound
	}

	var buf strings.Builder
	for _, b := range kept {
		if b.host != "" {
			buf.WriteString("Host " + b.host + "\n")
		}
		for _, l := range b.lines {
			buf.WriteString(l + "\n")
		}
	}
	if err := atomicfile.Write(configPath, []byte(buf.String()), 0o644, 0o755); err != nil {
		return err
	}

	if identityFile != "" {
		_ = os.Remove(identityFile)
		_ = os.Remove(identityFile + ".pub")
	}
	return nil
}
