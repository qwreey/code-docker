package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webmanager/internal/authgate"
)

// unlockForTest drives the real unlock handler against a gate whose
// password is pw, and returns the unlock cookie.
func unlockForTest(t *testing.T, s *Server, pw string) (*http.Cookie, map[string]bool) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/unlock", strings.NewReader(`{"password":"`+pw+`"}`))
	rec := httptest.NewRecorder()
	s.handleAuthUnlock(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unlock returned %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == authgate.CookieName {
			return c, body
		}
	}
	t.Fatal("unlock set no cookie")
	return nil, nil
}

func statusForTest(t *testing.T, s *Server, cookie *http.Cookie) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	s.handleAuthStatus(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestWeakGatePasswordIsShownOnlyToAnUnlockedSession(t *testing.T) {
	hash, err := authgate.HashPassword("short-pw")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{gate: authgate.New(hash)}

	// Before anyone typed the password: nothing to report either way.
	if st := statusForTest(t, s, nil); st["weakPassword"] != nil {
		t.Fatalf("status before any unlock carries weakPassword: %v", st)
	}

	cookie, unlockBody := unlockForTest(t, s, "short-pw")
	if !unlockBody["weakPassword"] {
		t.Fatalf("unlock response did not flag the short password: %v", unlockBody)
	}

	if st := statusForTest(t, s, cookie); st["weakPassword"] != true {
		t.Fatalf("unlocked status did not flag it: %v", st)
	}
	// No cookie, a forged cookie, and a locked-out request all look the same
	// as a gate that never saw the password.
	if st := statusForTest(t, s, nil); st["weakPassword"] != nil || st["unlocked"] != false {
		t.Fatalf("anonymous status leaks the flag: %v", st)
	}
	forged := &http.Cookie{Name: authgate.CookieName, Value: "AAAA.BBBB"}
	if st := statusForTest(t, s, forged); st["weakPassword"] != nil {
		t.Fatalf("forged-cookie status leaks the flag: %v", st)
	}
}

func TestStrongGatePasswordIsNotFlagged(t *testing.T) {
	hash, err := authgate.HashPassword("a-long-enough-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{gate: authgate.New(hash)}
	cookie, unlockBody := unlockForTest(t, s, "a-long-enough-passphrase")
	if unlockBody["weakPassword"] {
		t.Fatalf("unlock flagged a strong password: %v", unlockBody)
	}
	if st := statusForTest(t, s, cookie); st["weakPassword"] != nil {
		t.Fatalf("status flagged a strong password: %v", st)
	}
}

func TestFailedUnlockRevealsNothing(t *testing.T) {
	hash, _ := authgate.HashPassword("short-pw")
	s := &Server{gate: authgate.New(hash)}
	// Prove the password once so the flag is set, then fail from another client.
	unlockForTest(t, s, "short-pw")
	req := httptest.NewRequest(http.MethodPost, "/api/auth/unlock", strings.NewReader(`{"password":"nope"}`))
	req.RemoteAddr = "192.0.2.9:1234"
	rec := httptest.NewRecorder()
	s.handleAuthUnlock(rec, req)
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "weak") {
		t.Fatalf("wrong password: %d %s", rec.Code, rec.Body.String())
	}
}
