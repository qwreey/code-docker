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
)

var hostLineRe = regexp.MustCompile(`(?i)^\s*Host\s+(\S+)\s*$`)

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

	keyPath := filepath.Join(keysDir, host)
	cmd := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", fmt.Sprintf("webmanager@%s", host))
	if out, err := cmd.CombinedOutput(); err != nil {
		return SSHHost{}, fmt.Errorf("ssh-keygen: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return SSHHost{}, err
	}
	if err := os.Chmod(keyPath+".pub", 0o644); err != nil {
		return SSHHost{}, err
	}

	block := fmt.Sprintf("\nHost %s\n    HostName %s\n    User %s\n    IdentityFile %s\n", host, hostname, user, keyPath)
	f, err := os.OpenFile(configPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return SSHHost{}, err
	}
	defer f.Close()
	if _, err := f.WriteString(block); err != nil {
		return SSHHost{}, err
	}

	pubData, _ := os.ReadFile(keyPath + ".pub")
	return SSHHost{
		Host:         host,
		HostName:     hostname,
		User:         user,
		IdentityFile: keyPath,
		PublicKey:    strings.TrimSpace(string(pubData)),
	}, nil
}

func DeleteSSHHost(configPath, host string) error {
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
	if err := os.WriteFile(configPath, []byte(buf.String()), 0o644); err != nil {
		return err
	}

	if identityFile != "" {
		_ = os.Remove(identityFile)
		_ = os.Remove(identityFile + ".pub")
	}
	return nil
}
