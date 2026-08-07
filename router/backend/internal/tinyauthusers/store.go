// Package tinyauthusers manages tinyauth's forward-auth user credentials as
// individual add/delete entries instead of one long hand-edited
// TINYAUTH_AUTH_USERS env var (see router/config/tinyauth/tinyauth.default.sh
// and docs/router.md - tinyauth itself only reads that env var once at
// process start, no hot-reload). The file this package writes
// (EnvFilePath) is sourced by tinyauth.default.sh before its final exec,
// unless the real TINYAUTH_AUTH_USERS env var is already set (that pin
// always wins, same priority as authgate's ROUTER_MANAGER_AUTH_PASSWORD_HASH).
package tinyauthusers

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// StorePath persists the user list (name + bcrypt hash). EnvFilePath is the
// rendered `TINYAUTH_AUTH_USERS=...` line tinyauth.default.sh sources. Kept
// in their own directory rather than under tinyauth's own
// /var/lib/code-docker-router/tinyauth (symlinked to tinyauth's /data VOLUME
// for its sqlite state) so router-manager's files don't mix into a directory
// tinyauth itself owns.
const (
	StorePath   = "/var/lib/code-docker-router/tinyauth-users/users.json"
	EnvFilePath = "/var/lib/code-docker-router/tinyauth-users/env"
)

var (
	ErrUserExists   = errors.New("tinyauth user already exists")
	ErrUserNotFound = errors.New("tinyauth user not found")
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_.@-]+$`)

// validateName rejects any name unsafe to embed unquoted in
// RenderEnvFile's output, which tinyauth.default.sh `source`s as a bash
// script - anything outside this charset (in particular "$", backticks,
// ":", ",", whitespace, control characters) could otherwise inject
// arbitrary shell commands into that source, or corrupt the
// name:hash,name:hash format itself. Same reasoning as
// internal/devproxy.ValidateName.
func validateName(name string) error {
	if !nameRe.MatchString(name) {
		return errors.New("name must contain only letters, digits, and . _ @ -")
	}
	return nil
}

// bcryptCost matches tinyauth's own `user create --docker` default (cost 10,
// $2a$ hashes - see docs/router.md/router/example-env.router).
const bcryptCost = 10

// User is a single tinyauth credential. PasswordHash is never serialized to
// JSON responses (see handlers_tinyauth.go) - only ever read/written here.
type User struct {
	Name         string `json:"name"`
	PasswordHash string `json:"-"`
}

func load(path string) ([]User, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []User{}, nil
		}
		return nil, err
	}
	var users []User
	if err := json.Unmarshal(data, &users); err != nil {
		return nil, err
	}
	return users, nil
}

// save writes users atomically (temp file + rename) - this is credential
// material, same care as authgate's own store.go.
func save(path string, users []User) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(users)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ListUsers returns every user's name only - callers must never leak
// PasswordHash back over the API.
func ListUsers(path string) ([]User, error) {
	return load(path)
}

// AddUser hashes plaintext with bcrypt and appends a new user, rejecting a
// name collision.
func AddUser(path, name, plaintext string) error {
	if name == "" || plaintext == "" {
		return errors.New("name and password are required")
	}
	if err := validateName(name); err != nil {
		return err
	}
	users, err := load(path)
	if err != nil {
		return err
	}
	for _, u := range users {
		if u.Name == name {
			return ErrUserExists
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plaintext), bcryptCost)
	if err != nil {
		return err
	}
	users = append(users, User{Name: name, PasswordHash: string(hash)})
	return save(path, users)
}

// DeleteUser removes a user by name.
func DeleteUser(path, name string) error {
	users, err := load(path)
	if err != nil {
		return err
	}
	found := false
	kept := make([]User, 0, len(users))
	for _, u := range users {
		if u.Name == name {
			found = true
			continue
		}
		kept = append(kept, u)
	}
	if !found {
		return ErrUserNotFound
	}
	return save(path, kept)
}

// RenderEnvFile writes users in tinyauth's own TINYAUTH_AUTH_USERS format
// (comma-separated name:bcryptHash pairs) to envPath, for
// tinyauth.default.sh to source before exec'ing tinyauth.
func RenderEnvFile(envPath string, users []User) error {
	pairs := make([]string, 0, len(users))
	for _, u := range users {
		pairs = append(pairs, u.Name+":"+u.PasswordHash)
	}
	line := "TINYAUTH_AUTH_USERS=" + strings.Join(pairs, ",") + "\n"
	if err := os.MkdirAll(filepath.Dir(envPath), 0o700); err != nil {
		return err
	}
	tmp := envPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(line), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, envPath)
}
