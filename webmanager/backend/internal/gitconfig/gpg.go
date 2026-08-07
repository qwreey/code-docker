package gitconfig

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrGPGNotInstalled is returned by every function in this file when the
// `gpg` binary isn't on PATH — config/build/build.default.sh now installs `gnupg`,
// but that only takes effect on the container's next rebuild, so this path
// must be handled gracefully (HTTP handlers map it to 501).
var ErrGPGNotInstalled = errors.New("gpg is not installed")

// ErrGPGKeyNotFound is returned when a key ID doesn't match any known key.
var ErrGPGKeyNotFound = errors.New("gpg key not found")

// ErrInvalidKeyID is returned by ExportPublicKey/DeleteGPGKey when keyID
// isn't a well-formed 40-hex-char fingerprint. Without this check, a value
// like "--homedir=/tmp/x" passed as a bare trailing exec.Command arg gets
// parsed by gpg as a flag instead of a literal search term (verified: gpg
// happily creates a new homedir at an attacker-chosen path) — since this
// package already only ever treats keyID as "the full fingerprint" (see
// GPGKey's doc comment), rejecting anything else is a pure correctness fix,
// not a behavior change for legitimate callers.
var ErrInvalidKeyID = errors.New("keyId must be a 40-character hex fingerprint")

var keyIDRe = regexp.MustCompile(`^[0-9A-Fa-f]{40}$`)

// ValidateKeyID reports whether keyID is a well-formed 40-hex-char GPG
// fingerprint. Every function in this file that shells out with a
// caller-supplied keyID calls this first, before exec.Command ever runs.
func ValidateKeyID(keyID string) error {
	if !keyIDRe.MatchString(keyID) {
		return ErrInvalidKeyID
	}
	return nil
}

// GPGKey identifies a secret key by its full 40-hex fingerprint (not the
// shorter 16-hex key ID gpg also prints): `gpg --batch --delete-secret-and-
// public-key` refuses anything shorter than a fingerprint ("can't do this in
// batch mode ... unless you specify the key by fingerprint", verified against
// gpg 2.4.9), so the fingerprint is the only ID that works for every
// operation here (list/export/delete) and is what's exposed as KeyID.
type GPGKey struct {
	KeyID     string `json:"keyId"`
	Uid       string `json:"uid"`
	CreatedAt string `json:"createdAt"`
}

func checkGPG() error {
	if _, err := exec.LookPath("gpg"); err != nil {
		return ErrGPGNotInstalled
	}
	return nil
}

// unescapeColon reverses gpg's `\x3a`-style escaping of literal colons in
// --with-colons text fields (e.g. inside a uid string). No other escapes are
// handled — sufficient for the identities webmanager itself generates.
func unescapeColon(s string) string {
	return strings.ReplaceAll(s, `\x3a`, ":")
}

// parseSecretKeysColon parses `gpg --list-secret-keys --with-colons` output.
// Each key is a "sec" record; the fingerprint comes from the "fpr" record
// immediately following it, and the human-readable identity from the next
// "uid" record — both before the next "sec"/"pub" record starts.
func parseSecretKeysColon(out []byte) []GPGKey {
	lines := strings.Split(string(out), "\n")
	keys := make([]GPGKey, 0)
	for i := 0; i < len(lines); i++ {
		fields := strings.Split(lines[i], ":")
		if len(fields) == 0 || fields[0] != "sec" {
			continue
		}
		k := GPGKey{}
		if len(fields) > 4 {
			k.KeyID = fields[4] // fallback if no fpr record is found below
		}
		if len(fields) > 5 && fields[5] != "" {
			if ts, err := strconv.ParseInt(fields[5], 10, 64); err == nil {
				k.CreatedAt = time.Unix(ts, 0).UTC().Format(time.RFC3339)
			}
		}
		for j := i + 1; j < len(lines); j++ {
			f2 := strings.Split(lines[j], ":")
			if len(f2) == 0 {
				continue
			}
			if f2[0] == "sec" || f2[0] == "pub" {
				break
			}
			if f2[0] == "fpr" && len(f2) > 9 && f2[9] != "" {
				k.KeyID = f2[9]
			}
			if f2[0] == "uid" && len(f2) > 9 {
				k.Uid = unescapeColon(f2[9])
			}
		}
		keys = append(keys, k)
	}
	return keys
}

// listSecretKeys runs `gpg --list-secret-keys --with-colons [filter]`. gpg
// exits non-zero when nothing matches — a specific filter (verified: "error
// reading key: No secret key", exit 2), or an empty/not-yet-initialized
// keyring (observed on some gpg versions/states even with no filter, e.g.
// before the homedir's keybox has ever been touched) — that's not a real
// error, just "no keys yet", and should come back as an empty list like
// every other "nothing here yet" case in this package (sshkeys.List, etc.),
// not a 500. checkGPG() already guarantees the gpg binary itself is
// runnable before this is ever called, so the only failure worth surfacing
// here is the process not starting at all (*exec.Error, not *exec.
// ExitError) — an *exec.ExitError just means gpg ran and reported nothing.
func listSecretKeys(filter string) ([]GPGKey, error) {
	args := []string{"--list-secret-keys", "--with-colons"}
	if filter != "" {
		args = append(args, filter)
	}
	out, err := exec.Command("gpg", args...).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return []GPGKey{}, nil
		}
		return nil, gpgExecError("gpg --list-secret-keys", err)
	}
	return parseSecretKeysColon(out), nil
}

func gpgExecError(context string, err error) error {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return fmt.Errorf("%s: %w: %s", context, err, strings.TrimSpace(string(ee.Stderr)))
	}
	return fmt.Errorf("%s: %w", context, err)
}

func ListGPGKeys() ([]GPGKey, error) {
	if err := checkGPG(); err != nil {
		return nil, err
	}
	return listSecretKeys("")
}

// GenerateGPGKey creates a passphrase-less ed25519 key non-interactively
// (headless container context, matching the ssh-keygen -N "" pattern used
// elsewhere) and returns it along with its armored public key.
func GenerateGPGKey(name, email string) (GPGKey, string, error) {
	if err := checkGPG(); err != nil {
		return GPGKey{}, "", err
	}
	if name == "" || email == "" {
		return GPGKey{}, "", errors.New("name and email are required")
	}

	uid := fmt.Sprintf("%s <%s>", name, email)
	cmd := exec.Command("gpg", "--batch", "--passphrase", "", "--quick-generate-key", uid, "default", "default", "never")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return GPGKey{}, "", fmt.Errorf("gpg --quick-generate-key: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	keys, err := listSecretKeys(email)
	if err != nil {
		return GPGKey{}, "", err
	}
	if len(keys) == 0 {
		return GPGKey{}, "", fmt.Errorf("gpg: generated key not found for %s", email)
	}
	key := keys[len(keys)-1] // most recently created match

	pub, err := ExportPublicKey(key.KeyID)
	if err != nil {
		return GPGKey{}, "", err
	}
	return key, pub, nil
}

// ExportPublicKey returns the armored public key for keyID. gpg exits 0 with
// empty stdout (and a stderr warning) when keyID doesn't match anything, so
// that case is translated into ErrGPGKeyNotFound.
func ExportPublicKey(keyID string) (string, error) {
	if err := checkGPG(); err != nil {
		return "", err
	}
	if err := ValidateKeyID(keyID); err != nil {
		return "", err
	}
	out, err := exec.Command("gpg", "--armor", "--export", keyID).Output()
	if err != nil {
		return "", gpgExecError("gpg --export", err)
	}
	if strings.TrimSpace(string(out)) == "" {
		return "", ErrGPGKeyNotFound
	}
	return string(out), nil
}

// DeleteGPGKey deletes both the secret and public key material for keyID.
// Existence is checked first so callers can distinguish "not found" from a
// genuine gpg failure.
func DeleteGPGKey(keyID string) error {
	if err := checkGPG(); err != nil {
		return err
	}
	if err := ValidateKeyID(keyID); err != nil {
		return err
	}
	keys, err := listSecretKeys(keyID)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return ErrGPGKeyNotFound
	}

	cmd := exec.Command("gpg", "--batch", "--yes", "--delete-secret-and-public-key", keyID)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("gpg --delete-secret-and-public-key: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
