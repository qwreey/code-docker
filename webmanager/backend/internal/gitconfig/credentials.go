package gitconfig

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

type Credential struct {
	Host     string `json:"host"`
	Username string `json:"username"`
}

var ErrCredentialNotFound = errors.New("credential not found")

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
		return Credential{}, fmt.Errorf("host, username and token are required")
	}

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
	if err := os.WriteFile(credsPath, []byte(content), 0o600); err != nil {
		return Credential{}, err
	}
	if err := os.Chmod(credsPath, 0o600); err != nil {
		return Credential{}, err
	}

	if err := ensureCredentialHelper(gitConfigPath, credsPath); err != nil {
		return Credential{}, err
	}

	return Credential{Host: host, Username: username}, nil
}

func DeleteCredential(credsPath, host string) error {
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
	if err := os.WriteFile(credsPath, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(credsPath, 0o600)
}

func ensureCredentialHelper(gitConfigPath, credsPath string) error {
	return exec.Command("git", "config", "--file", gitConfigPath, "credential.helper", fmt.Sprintf("store --file=%s", credsPath)).Run()
}
