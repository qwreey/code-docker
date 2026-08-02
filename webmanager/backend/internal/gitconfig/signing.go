package gitconfig

import (
	"errors"
	"strconv"
)

// Signing is the subset of git config controlling commit signing.
type Signing struct {
	Mode          string `json:"mode"` // "none", "ssh" or "gpg"
	SigningKey    string `json:"signingKey"`
	CommitGpgSign bool   `json:"commitGpgSign"`
}

var ErrInvalidSigningMode = errors.New("mode must be none, ssh or gpg")

// GetSigning reads gpg.format/user.signingkey/commit.gpgsign and derives
// Mode: an empty signingkey means "none" regardless of gpg.format; otherwise
// gpg.format=ssh means "ssh", anything else (openpgp or unset) means "gpg".
func GetSigning(path string) (Signing, error) {
	format, err := getConfig(path, "gpg.format")
	if err != nil {
		return Signing{}, err
	}
	signingKey, err := getConfig(path, "user.signingkey")
	if err != nil {
		return Signing{}, err
	}
	gpgSign, err := getConfig(path, "commit.gpgsign")
	if err != nil {
		return Signing{}, err
	}

	mode := "none"
	if signingKey != "" {
		if format == "ssh" {
			mode = "ssh"
		} else {
			mode = "gpg"
		}
	}

	return Signing{
		Mode:          mode,
		SigningKey:    signingKey,
		CommitGpgSign: gpgSign == "true",
	}, nil
}

// SetSigning validates s.Mode and writes the corresponding git config keys.
// "none" unsets all three keys (via setConfig(path, key, "") — see user.go).
func SetSigning(path string, s Signing) error {
	switch s.Mode {
	case "none":
		if err := setConfig(path, "gpg.format", ""); err != nil {
			return err
		}
		if err := setConfig(path, "user.signingkey", ""); err != nil {
			return err
		}
		return setConfig(path, "commit.gpgsign", "")
	case "ssh":
		if err := setConfig(path, "gpg.format", "ssh"); err != nil {
			return err
		}
	case "gpg":
		if err := setConfig(path, "gpg.format", "openpgp"); err != nil {
			return err
		}
	default:
		return ErrInvalidSigningMode
	}

	if err := setConfig(path, "user.signingkey", s.SigningKey); err != nil {
		return err
	}
	return setConfig(path, "commit.gpgsign", strconv.FormatBool(s.CommitGpgSign))
}
