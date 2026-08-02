// Package gitconfig manages the pieces of git configuration webmanager
// exposes: user.name/user.email, SSH-key-based host auth (~/.ssh/config +
// generated keypairs), HTTPS credential-store entries, git-lfs install
// status, and raw read/write access to the gitconfig file itself.
package gitconfig

import (
	"errors"
	"os/exec"
	"strings"
)

type User struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

func GetUser(path string) (User, error) {
	name, err := getConfig(path, "user.name")
	if err != nil {
		return User{}, err
	}
	email, err := getConfig(path, "user.email")
	if err != nil {
		return User{}, err
	}
	return User{Name: name, Email: email}, nil
}

// SetUser sets user.name/user.email, unsetting a key instead of writing an
// empty value when the corresponding field is "".
func SetUser(path string, u User) error {
	if err := setConfig(path, "user.name", u.Name); err != nil {
		return err
	}
	return setConfig(path, "user.email", u.Email)
}

// getConfig exit code 1 means "key not set" (verified against git 2.55),
// not a real error — missing files behave the same way.
func getConfig(path, key string) (string, error) {
	out, err := exec.Command("git", "config", "--file", path, key).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// setConfig exit code 5 on --unset means "key already absent", also not
// a real error.
func setConfig(path, key, value string) error {
	if value == "" {
		err := exec.Command("git", "config", "--file", path, "--unset", key).Run()
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) && ee.ExitCode() == 5 {
				return nil
			}
			return err
		}
		return nil
	}
	return exec.Command("git", "config", "--file", path, key, value).Run()
}
