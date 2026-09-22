// Package webauthnunlock is a second way to satisfy internal/authgate's
// password gate: a fingerprint/face/device-PIN check through WebAuthn
// instead of typing the password. See
// webmanager/.claude/research/webauthn-prf-unlock-research.md for why this is
// a server-side WebAuthn relying party rather than a password wrapped with
// the PRF extension (short version: passkeyd, the Linux fprintd bridge the
// owner uses, has no hmac-secret/PRF at all; and a wrapped password would be
// rebuilt in page JavaScript on every unlock, where any same-origin script
// could take it).
//
// What it stores (one JSON file, 0600): each enrolled credential's public
// key with the host it was enrolled on, a random user handle, the time of the
// last *typed* password unlock, and a tag of the configured password hash.
// Nothing secret: a public key can't unlock anything by itself.
//
// Rules this package enforces, each a deliberate decision:
//   - A credential is only usable on the exact host it was enrolled on (its
//     RP ID), never a parent domain - router vhosts put side projects on
//     sibling hostnames precisely to keep them off this origin.
//   - Enrollment needs the password itself, not just an unlocked cookie.
//   - A WebAuthn unlock never extends authgate's 12h hard cap: the token it
//     mints counts from the last typed password, so the password is still
//     needed at least every 12h (PasswordAt / authgate.IssueFrom).
//   - Changing the password hash revokes every credential (hash tag).
//   - User verification (fingerprint, face, device PIN) is required.
//
// The file lives on the /code volume, which a root shell inside the
// container can edit - adding its own public key there would unlock the
// gate. That isn't a new hole: such a shell can already read the process
// environment and memory. It is stated here so nobody mistakes this file for
// something the gate's "hash only changeable host-side" rule protects.
package webauthnunlock

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"webmanager/internal/atomicfile"
)

// ceremonyTTL bounds how long a begun registration/unlock can be finished.
// Browsers time a WebAuthn prompt out on their own well before this.
const ceremonyTTL = 3 * time.Minute

// maxCeremonies caps how many begun-but-unfinished ceremonies are kept. The
// unlock begin is ungated, so without a cap a loop of begins could grow the
// map (and the sweep every insert does under the lock) without bound; past
// the cap the oldest is dropped, which only fails a ceremony that was
// abandoned anyway.
const maxCeremonies = 64

type ceremonyKind int

const (
	kindRegister ceremonyKind = iota + 1
	kindUnlock
)

var (
	ErrUnknownCeremony = errors.New("webauthn: unknown or expired ceremony - start again")
	ErrNoCredentials   = errors.New("webauthn: no credential enrolled for this host")
	ErrBadOrigin       = errors.New("webauthn: response came from an unexpected origin")
	// ErrMalformed marks a response that couldn't even be parsed - a client
	// mishap, not a failed verification.
	ErrMalformed = errors.New("webauthn: malformed response")
	ErrNotFound  = errors.New("webauthn: no such credential")
)

type storedCredential struct {
	RPID       string              `json:"rpId"`
	Label      string              `json:"label"`
	CreatedAt  time.Time           `json:"createdAt"`
	LastUsedAt *time.Time          `json:"lastUsedAt,omitempty"`
	Credential webauthn.Credential `json:"credential"`
}

type document struct {
	HashTag     string             `json:"hashTag"`
	UserID      []byte             `json:"userId"`
	PasswordAt  time.Time          `json:"passwordAt"`
	Credentials []storedCredential `json:"credentials"`
}

type ceremony struct {
	// kind keeps the two ceremonies apart: an unlock challenge (handed out
	// without a password) must never be usable to finish a registration.
	// Without it, only go-webauthn happening to check an unlock session's
	// empty credential parameters stood between that and enrolling a key
	// with no password at all.
	kind    ceremonyKind
	rpID    string
	label   string
	data    webauthn.SessionData
	expires time.Time
}

// Manager holds the credential store and in-flight ceremonies. Safe for
// concurrent use.
type Manager struct {
	path string

	mu         sync.Mutex
	doc        document
	ceremonies map[string]ceremony
}

// Info is what the credential list shows. ID is the credential ID,
// base64url.
type Info struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	RPID       string     `json:"rpId"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

// Open loads (or starts) the store at path. passwordHash is the gate's
// configured hash: when it no longer matches what the store was written
// under, every credential is dropped - a password change revokes the
// fingerprint unlocks enrolled under the old one. revoked reports how many.
func Open(path, passwordHash string) (m *Manager, revoked int, err error) {
	m = &Manager{path: path, ceremonies: map[string]ceremony{}}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &m.doc); err != nil {
			return nil, 0, fmt.Errorf("webauthn: parsing %s: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, 0, err
	}

	tag := hashTag(passwordHash)
	dirty := false
	if m.doc.HashTag != tag {
		revoked = len(m.doc.Credentials)
		m.doc.Credentials = nil
		m.doc.PasswordAt = time.Time{}
		m.doc.HashTag = tag
		dirty = true
	}
	if len(m.doc.UserID) == 0 {
		m.doc.UserID = make([]byte, 32)
		if _, err := rand.Read(m.doc.UserID); err != nil {
			return nil, 0, err
		}
		dirty = true
	}
	if dirty {
		if err := m.saveLocked(); err != nil {
			return nil, 0, err
		}
	}
	return m, revoked, nil
}

func hashTag(passwordHash string) string {
	sum := sha256.Sum256([]byte(passwordHash))
	return hex.EncodeToString(sum[:8])
}

func (m *Manager) saveLocked() error {
	data, err := json.MarshalIndent(m.doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(m.path, data, 0o600, 0o755)
}

// RecordPasswordUnlock notes that the password was just typed - the start
// of the window in which WebAuthn unlocks are accepted.
func (m *Manager) RecordPasswordUnlock(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.doc.PasswordAt = now
	if err := m.saveLocked(); err != nil {
		log.Printf("webauthn: recording the password unlock time: %v", err)
	}
}

// PasswordAt is the last typed password unlock (zero if never, or since
// the password changed).
func (m *Manager) PasswordAt() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.doc.PasswordAt
}

// HasCredentials reports whether anything is enrolled for rpID.
func (m *Manager) HasCredentials(rpID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.doc.Credentials {
		if c.RPID == rpID {
			return true
		}
	}
	return false
}

// List returns every enrolled credential, newest first.
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.doc.Credentials))
	for _, c := range m.doc.Credentials {
		out = append(out, Info{
			ID:         base64.RawURLEncoding.EncodeToString(c.Credential.ID),
			Label:      c.Label,
			RPID:       c.RPID,
			CreatedAt:  c.CreatedAt,
			LastUsedAt: c.LastUsedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// Delete removes one credential by its base64url ID.
func (m *Manager) Delete(id string) error {
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, c := range m.doc.Credentials {
		if bytes.Equal(c.Credential.ID, raw) {
			prev := m.doc.Credentials
			m.doc.Credentials = append(append([]storedCredential(nil), prev[:i]...), prev[i+1:]...)
			if err := m.saveLocked(); err != nil {
				m.doc.Credentials = prev
				return err
			}
			return nil
		}
	}
	return ErrNotFound
}

// user is the single account this gate protects, seen from one host: only
// that host's credentials take part in a ceremony there.
type user struct {
	id    []byte
	creds []webauthn.Credential
}

func (u user) WebAuthnID() []byte                         { return u.id }
func (u user) WebAuthnName() string                       { return "webmanager" }
func (u user) WebAuthnDisplayName() string                { return "webmanager" }
func (u user) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func (m *Manager) userLocked(rpID string) user {
	u := user{id: m.doc.UserID}
	for _, c := range m.doc.Credentials {
		if c.RPID == rpID {
			u.creds = append(u.creds, c.Credential)
		}
	}
	return u
}

// relyingParty builds the go-webauthn config for one host. origins is only
// consulted when finishing a ceremony; see checkOrigin for how it is chosen.
func relyingParty(rpID string, origins []string) (*webauthn.WebAuthn, error) {
	if len(origins) == 0 {
		origins = []string{"https://" + rpID}
	}
	return webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "webmanager",
		RPOrigins:     origins,
	})
}

// checkOrigin accepts the origin the browser signed into clientDataJSON when
// its host is exactly rpID, over HTTPS - or plain HTTP on localhost, the one
// non-HTTPS origin browsers allow WebAuthn on. The port is left to whatever
// the browser used: webmanager sits behind a proxy and can't know it, and
// origins differing only by port share an RP ID anyway.
func checkOrigin(origin, rpID string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() != rpID {
		return ErrBadOrigin
	}
	if u.Scheme == "https" || (u.Scheme == "http" && rpID == "localhost") {
		return nil
	}
	return ErrBadOrigin
}

// RPIDFromHost turns a request's Host header into an RP ID: the bare
// hostname. IP addresses are refused - WebAuthn doesn't allow them as RP IDs.
func RPIDFromHost(host string) (string, bool) {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || net.ParseIP(host) != nil {
		return "", false
	}
	return host, true
}

func newCeremonyID() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (m *Manager) putCeremony(c ceremony) string {
	now := time.Now()
	for id, old := range m.ceremonies {
		if now.After(old.expires) {
			delete(m.ceremonies, id)
		}
	}
	for len(m.ceremonies) >= maxCeremonies {
		oldestID, oldest := "", time.Time{}
		for id, old := range m.ceremonies {
			if oldestID == "" || old.expires.Before(oldest) {
				oldestID, oldest = id, old.expires
			}
		}
		delete(m.ceremonies, oldestID)
	}
	id := newCeremonyID()
	c.expires = now.Add(ceremonyTTL)
	m.ceremonies[id] = c
	return id
}

func (m *Manager) takeCeremony(id string, kind ceremonyKind) (ceremony, error) {
	c, ok := m.ceremonies[id]
	delete(m.ceremonies, id)
	if !ok || c.kind != kind || time.Now().After(c.expires) {
		return ceremony{}, ErrUnknownCeremony
	}
	return c, nil
}

// BeginRegistration starts enrolling a new credential on rpID. The caller
// has already checked the password.
func (m *Manager) BeginRegistration(rpID, label string) (*protocol.CredentialCreation, string, error) {
	rp, err := relyingParty(rpID, nil)
	if err != nil {
		return nil, "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.userLocked(rpID)
	exclude := make([]protocol.CredentialDescriptor, 0, len(u.creds))
	for _, c := range u.creds {
		exclude = append(exclude, c.Descriptor())
	}
	// A discoverable credential (a passkey), not "discouraged": on Android,
	// Chrome sends a discouraged request down the old Play Services FIDO2
	// path, which offered a security key or a Google Password Manager entry
	// that led nowhere instead of the fingerprint. Required goes through
	// Android's Credential Manager and the device's passkey provider. No
	// authenticatorAttachment: "platform" would drop a USB-attached one such
	// as passkeyd on a Linux desktop, which advertises rk but is still HID.
	creation, data, err := rp.BeginRegistration(u,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		return nil, "", err
	}
	id := m.putCeremony(ceremony{kind: kindRegister, rpID: rpID, label: label, data: *data})
	return creation, id, nil
}

// FinishRegistration verifies the browser's attestation response and stores
// the new credential.
func (m *Manager) FinishRegistration(ceremonyID, rpID string, body io.Reader) error {
	parsed, err := protocol.ParseCredentialCreationResponseBody(body)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := checkOrigin(parsed.Response.CollectedClientData.Origin, rpID); err != nil {
		return err
	}
	rp, err := relyingParty(rpID, []string{parsed.Response.CollectedClientData.Origin})
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.takeCeremony(ceremonyID, kindRegister)
	if err != nil {
		return err
	}
	if c.rpID != rpID {
		return ErrBadOrigin
	}
	cred, err := rp.CreateCredential(m.userLocked(rpID), c.data, parsed)
	if err != nil {
		return err
	}
	m.doc.Credentials = append(m.doc.Credentials, storedCredential{
		RPID:       rpID,
		Label:      c.label,
		CreatedAt:  time.Now(),
		Credential: *cred,
	})
	return m.saveLocked()
}

// BeginUnlock starts an unlock ceremony for rpID's credentials.
func (m *Manager) BeginUnlock(rpID string) (*protocol.CredentialAssertion, string, error) {
	rp, err := relyingParty(rpID, nil)
	if err != nil {
		return nil, "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.userLocked(rpID)
	if len(u.creds) == 0 {
		return nil, "", ErrNoCredentials
	}
	assertion, data, err := rp.BeginLogin(u, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return nil, "", err
	}
	id := m.putCeremony(ceremony{kind: kindUnlock, rpID: rpID, data: *data})
	return assertion, id, nil
}

// FinishUnlock verifies the browser's assertion and returns the base64url ID
// of the credential that signed it. On success the caller mints the unlock
// cookie.
func (m *Manager) FinishUnlock(ceremonyID, rpID string, body io.Reader) (string, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBody(body)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := checkOrigin(parsed.Response.CollectedClientData.Origin, rpID); err != nil {
		return "", err
	}
	rp, err := relyingParty(rpID, []string{parsed.Response.CollectedClientData.Origin})
	if err != nil {
		return "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	c, err := m.takeCeremony(ceremonyID, kindUnlock)
	if err != nil {
		return "", err
	}
	if c.rpID != rpID {
		return "", ErrBadOrigin
	}
	cred, err := rp.ValidateLogin(m.userLocked(rpID), c.data, parsed)
	if err != nil {
		return "", err
	}
	// A counter that went backwards means a cloned authenticator. Most
	// platform authenticators (passkeys) always report 0, which is fine.
	if cred.Authenticator.CloneWarning {
		return "", errors.New("webauthn: authenticator signature counter went backwards - refusing (possible cloned key)")
	}
	now := time.Now()
	for i := range m.doc.Credentials {
		sc := &m.doc.Credentials[i]
		if sc.RPID == rpID && bytes.Equal(sc.Credential.ID, cred.ID) {
			sc.Credential.Authenticator.SignCount = cred.Authenticator.SignCount
			sc.LastUsedAt = &now
		}
	}
	return base64.RawURLEncoding.EncodeToString(cred.ID), m.saveLocked()
}
