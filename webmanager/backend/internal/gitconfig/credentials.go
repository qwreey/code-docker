package gitconfig

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"

	"webmanager/internal/atomicfile"
)

type Credential struct {
	Host     string `json:"host"`
	Username string `json:"username"`
}

var (
	ErrCredentialNotFound = errors.New("credential not found")
	// ErrInvalidCredential distinguishes a genuine input-validation
	// rejection from an I/O failure elsewhere in UpsertCredential - see
	// raw.go's identical ErrInvalidGitConfigSyntax for the full reasoning.
	ErrInvalidCredential = errors.New("invalid credential")
)

// credentialsMu serializes read-modify-write access to credsPath - see
// internal/sshkeys' identical mu for why (lost-update prevention across
// concurrent requests).
var credentialsMu sync.Mutex

func parseCredentialLine(line string) (host, username string, ok bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return "", "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return "", "", false
	}
	return u.Host, u.User.Username(), true
}

func ListCredentials(path string) ([]Credential, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Credential{}, nil
		}
		return nil, err
	}
	out := make([]Credential, 0)
	for _, line := range strings.Split(string(data), "\n") {
		if host, user, ok := parseCredentialLine(line); ok {
			out = append(out, Credential{Host: host, Username: user})
		}
	}
	return out, nil
}

// UpsertCredential replaces any existing entry for host and (re-)points
// git's credential.helper at the store file, since a fresh install has
// neither the file nor the gitconfig entry yet.
func UpsertCredential(credsPath, gitConfigPath, host, username, token string) (Credential, error) {
	if host == "" || username == "" || token == "" {
		return Credential{}, fmt.Errorf("%w: host, username and token are required", ErrInvalidCredential)
	}
	// Defense-in-depth, not the only thing preventing a line-injection into
	// credsPath: url.URL.String() below already percent-encodes \n/\r in
	// Host (confirmed - net/url's host encoder escapes both), but that
	// safety is incidental to net/url's implementation rather than an
	// explicit check, unlike every sibling parser in this package
	// (knownhosts.go's parseKnownHostLine, sshhosts.go's
	// validateAddSSHHostInput) which reject this outright.
	if strings.ContainsAny(host, "\n\r") {
		return Credential{}, fmt.Errorf("%w: host must not contain newlines", ErrInvalidCredential)
	}

	credentialsMu.Lock()
	defer credentialsMu.Unlock()

	data, err := os.ReadFile(credsPath)
	if err != nil && !os.IsNotExist(err) {
		return Credential{}, err
	}

	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		if h, _, ok := parseCredentialLine(line); ok && h == host {
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		kept = append(kept, line)
	}
	u := &url.URL{Scheme: "https", User: url.UserPassword(username, token), Host: host}
	kept = append(kept, u.String())

	content := strings.Join(kept, "\n") + "\n"
	if err := atomicfile.Write(credsPath, []byte(content), 0o600, 0o700); err != nil {
		return Credential{}, err
	}

	if err := ensureCredentialHelper(gitConfigPath, credsPath); err != nil {
		return Credential{}, err
	}

	return Credential{Host: host, Username: username}, nil
}

func DeleteCredential(credsPath, host string) error {
	credentialsMu.Lock()
	defer credentialsMu.Unlock()

	data, err := os.ReadFile(credsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrCredentialNotFound
		}
		return err
	}

	found := false
	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		if h, _, ok := parseCredentialLine(line); ok {
			if h == host {
				found = true
				continue
			}
		} else if strings.TrimSpace(line) == "" {
			continue
		}
		kept = append(kept, line)
	}
	if !found {
		return ErrCredentialNotFound
	}

	content := ""
	if len(kept) > 0 {
		content = strings.Join(kept, "\n") + "\n"
	}
	return atomicfile.Write(credsPath, []byte(content), 0o600, 0o700)
}

func ensureCredentialHelper(gitConfigPath, credsPath string) error {
	return exec.Command("git", "config", "--file", gitConfigPath, "credential.helper", fmt.Sprintf("store --file=%s", credsPath)).Run()
}
