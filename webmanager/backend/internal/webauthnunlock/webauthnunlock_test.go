package webauthnunlock

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// A password change must revoke every credential enrolled under the old
// one, and forget the last password unlock too (it was the old password).
func TestOpenRevokesOnPasswordChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "webauthn.json")
	m, revoked, err := Open(path, "hash-a")
	if err != nil || revoked != 0 {
		t.Fatalf("Open = %v, revoked %d", err, revoked)
	}
	m.RecordPasswordUnlock(time.Now())
	m.doc.Credentials = append(m.doc.Credentials, storedCredential{RPID: "code.example", Credential: webauthn.Credential{ID: []byte{1}}})
	if err := m.saveLocked(); err != nil {
		t.Fatal(err)
	}

	same, revoked, err := Open(path, "hash-a")
	if err != nil || revoked != 0 || !same.HasCredentials("code.example") || same.PasswordAt().IsZero() {
		t.Fatalf("reopen with the same hash lost state: err=%v revoked=%d", err, revoked)
	}
	changed, revoked, err := Open(path, "hash-b")
	if err != nil || revoked != 1 || changed.HasCredentials("code.example") || !changed.PasswordAt().IsZero() {
		t.Fatalf("reopen with a new hash: err=%v revoked=%d creds=%v", err, revoked, changed.HasCredentials("code.example"))
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("store file mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
}

// Credentials are per exact host: one enrolled on code.example must not be
// offered, or accepted, on a sibling or parent host.
func TestCredentialsAreScopedToTheirHost(t *testing.T) {
	m, _, err := Open(filepath.Join(t.TempDir(), "w.json"), "h")
	if err != nil {
		t.Fatal(err)
	}
	m.doc.Credentials = []storedCredential{{RPID: "code.example", Credential: webauthn.Credential{ID: []byte{1}}}}
	if !m.HasCredentials("code.example") || m.HasCredentials("example") || m.HasCredentials("app.code.example") {
		t.Fatal("HasCredentials leaked across hosts")
	}
	if _, _, err := m.BeginUnlock("other.example"); err != ErrNoCredentials {
		t.Fatalf("BeginUnlock on a host with nothing enrolled = %v, want ErrNoCredentials", err)
	}
}

func TestRPIDFromHost(t *testing.T) {
	for _, c := range []struct {
		host string
		want string
		ok   bool
	}{
		{"code.example", "code.example", true},
		{"Code.Example:8443", "code.example", true},
		{"localhost:81", "localhost", true},
		{"192.168.1.5", "", false},
		{"[::1]:80", "", false},
		{"", "", false},
	} {
		got, ok := RPIDFromHost(c.host)
		if got != c.want || ok != c.ok {
			t.Errorf("RPIDFromHost(%q) = %q, %v; want %q, %v", c.host, got, ok, c.want, c.ok)
		}
	}
}

func TestCheckOrigin(t *testing.T) {
	for _, c := range []struct {
		origin, rpID string
		ok           bool
	}{
		{"https://code.example", "code.example", true},
		{"https://code.example:8443", "code.example", true},
		{"http://code.example", "code.example", false},
		{"https://evil.code.example", "code.example", false},
		{"https://example", "code.example", false},
		{"http://localhost:8080", "localhost", true},
		{"not a url", "code.example", false},
	} {
		if err := checkOrigin(c.origin, c.rpID); (err == nil) != c.ok {
			t.Errorf("checkOrigin(%q, %q) = %v, want ok=%v", c.origin, c.rpID, err, c.ok)
		}
	}
}

func TestCeremonyIsSingleUse(t *testing.T) {
	m, _, err := Open(filepath.Join(t.TempDir(), "w.json"), "h")
	if err != nil {
		t.Fatal(err)
	}
	if _, id, err := m.BeginRegistration("code.example", "x"); err != nil {
		t.Fatal(err)
	} else {
		if _, err := m.takeCeremony(id); err != nil {
			t.Fatalf("first take: %v", err)
		}
		if _, err := m.takeCeremony(id); err != ErrUnknownCeremony {
			t.Fatalf("second take = %v, want ErrUnknownCeremony", err)
		}
	}
}
