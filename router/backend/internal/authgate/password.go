// Package authgate is a minimal, opt-in password gate for router-manager's
// own mutating admin routes (tailscale login/forwards/publish writes,
// dev-proxy expose writes) — see router/plan.md's "router-manager 자체
// admin API 인증". Mirrors webmanager/backend/internal/authgate's design
// (same argon2id + HMAC-signed-cookie approach), but as its own package:
// router-manager is a separate Go module/binary, so the two can't share
// code without a shared module neither side currently has, and duplicating
// ~300 lines of self-contained auth logic is cheaper than introducing one
// just for this.
//
// The gate is entirely opt-in and defaults to open: if no password hash is
// configured, RequirePassword passes every request through unconditionally
// — nothing that already works unauthenticated should start failing just
// because this package exists.
package authgate

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. Commonly-cited safe defaults (RFC 9106's "second
// recommended option" for memory-constrained environments), not tuned
// further for this deployment.
const (
	argonMemoryKiB   = 64 * 1024 // 64 MiB
	argonTime        = 3
	argonParallelism = 2
	argonKeyLen      = 32
	argonSaltLen     = 16
)

var (
	// ErrInvalidHash is returned when an encoded hash string doesn't match
	// the expected $argon2id$v=19$m=...,t=...,p=...$salt$hash format.
	ErrInvalidHash = errors.New("authgate: invalid encoded hash format")
	// ErrIncompatibleVersion is returned when an encoded hash was produced
	// by a different argon2 version than this package links against.
	ErrIncompatibleVersion = errors.New("authgate: incompatible argon2 version")
)

// HashPassword derives an argon2id hash for plaintext and encodes it in the
// standard textual format used by most argon2id implementations:
//
//	$argon2id$v=19$m=65536,t=3,p=2$<salt-b64>$<hash-b64>
func HashPassword(plaintext string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("authgate: generating salt: %w", err)
	}

	key := argon2.IDKey([]byte(plaintext), salt, argonTime, argonMemoryKiB, argonParallelism, argonKeyLen)

	encoded := fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		argonMemoryKiB, argonTime, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
	return encoded, nil
}

// VerifyPassword checks plaintext against an encoded argon2id hash produced
// by HashPassword. Re-derives the key using the params/salt embedded in
// encodedHash and compares in constant time.
func VerifyPassword(plaintext, encodedHash string) (bool, error) {
	// Expected: ["", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash]
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	if version != argon2.Version {
		return false, ErrIncompatibleVersion
	}

	var memory, time uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &parallelism); err != nil {
		return false, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	hash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}

	computed := argon2.IDKey([]byte(plaintext), salt, time, memory, parallelism, uint32(len(hash)))
	return subtle.ConstantTimeCompare(hash, computed) == 1, nil
}
