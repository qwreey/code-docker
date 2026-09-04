package gitconfig

import (
	"errors"
	"strconv"
	"strings"
)

// AITrailer is the config for the commit-message hook that rewrites the
// Co-Authored-By trailer an agent harness appends. The hook itself
// (config/git/hooks/ai-trailer.sh) reads these same keys straight out of git
// config, so it keeps working with webmanager stopped - this type only exists
// to give the Git Config tab something to read and write.
type AITrailer struct {
	Enabled bool `json:"enabled"`
	// Name/Email may be empty, in which case the hook falls back to
	// user.name/user.email.
	Name         string `json:"name"`
	Email        string `json:"email"`
	KeepModel    bool   `json:"keepModel"`
	StripSession bool   `json:"stripSession"`

	// HookActive is read-only (ignored on write): whether core.hooksPath
	// actually points at this image's hook directory. user-init refuses to
	// overwrite a core.hooksPath the user set themselves, so this can be
	// false on a perfectly healthy container - and then Enabled does
	// nothing at all, which the UI needs to be able to say out loud.
	HookActive bool `json:"hookActive"`
}

// HooksPath is where the image installs its hooks and what user-init points
// core.hooksPath at (Dockerfile + config/user-init/user-init.default.sh).
const HooksPath = "/etc/code-docker/git/hooks"

// ErrInvalidTrailerIdentity guards the two fields that get interpolated
// straight into a trailer line. Angle brackets would produce a second, broken
// address; control characters would split one trailer into two lines.
var ErrInvalidTrailerIdentity = errors.New("name and email must not contain '<', '>' or control characters")

func validateTrailerPart(s string) error {
	if strings.ContainsAny(s, "<>\n\r\x00") {
		return ErrInvalidTrailerIdentity
	}
	return nil
}

// GetAITrailer reads codedocker.aitrailer.*. An unset key is not the same as
// "false" here: enabled defaults off (see the hook's own header for why), while
// keepModel/stripSession default on, so only an explicit "false" turns those
// two off.
func GetAITrailer(path string) (AITrailer, error) {
	enabled, err := getConfig(path, "codedocker.aitrailer.enabled")
	if err != nil {
		return AITrailer{}, err
	}
	name, err := getConfig(path, "codedocker.aitrailer.name")
	if err != nil {
		return AITrailer{}, err
	}
	email, err := getConfig(path, "codedocker.aitrailer.email")
	if err != nil {
		return AITrailer{}, err
	}
	keepModel, err := getConfig(path, "codedocker.aitrailer.keepModel")
	if err != nil {
		return AITrailer{}, err
	}
	stripSession, err := getConfig(path, "codedocker.aitrailer.stripSession")
	if err != nil {
		return AITrailer{}, err
	}

	hooksPath, err := getConfig(path, "core.hooksPath")
	if err != nil {
		return AITrailer{}, err
	}

	return AITrailer{
		Enabled:      enabled == "true",
		Name:         name,
		Email:        email,
		KeepModel:    keepModel != "false",
		StripSession: stripSession != "false",
		HookActive:   hooksPath == HooksPath,
	}, nil
}

// SetAITrailer writes all five keys. Name/Email are unset rather than written
// empty (setConfig's own convention), so clearing them in the UI restores the
// user.name/user.email fallback instead of leaving an empty string behind.
// keepModel/stripSession are always written explicitly, since their unset
// state means "on" and there would otherwise be no way to persist "off".
func SetAITrailer(path string, t AITrailer) error {
	if err := validateTrailerPart(t.Name); err != nil {
		return err
	}
	if err := validateTrailerPart(t.Email); err != nil {
		return err
	}

	if err := setConfig(path, "codedocker.aitrailer.enabled", strconv.FormatBool(t.Enabled)); err != nil {
		return err
	}
	if err := setConfig(path, "codedocker.aitrailer.name", t.Name); err != nil {
		return err
	}
	if err := setConfig(path, "codedocker.aitrailer.email", t.Email); err != nil {
		return err
	}
	if err := setConfig(path, "codedocker.aitrailer.keepModel", strconv.FormatBool(t.KeepModel)); err != nil {
		return err
	}
	return setConfig(path, "codedocker.aitrailer.stripSession", strconv.FormatBool(t.StripSession))
}
