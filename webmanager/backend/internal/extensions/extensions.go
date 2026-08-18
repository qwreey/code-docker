// Package extensions loads the repo-root recommendations file
// (config/code/recommendations.default.yaml, baked into the image at
// /etc/code-docker/code/recommendations.default.yaml — see repo root
// CLAUDE.md's "override pattern") and wraps the code-server CLI's own
// --list-extensions/--install-extension flags, following the same
// override-resolution order as config/code/code-service.default.sh: an
// override path wins if present, else the default path, else degrade
// gracefully.
package extensions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Recommended is one entry under the recommendations file's `extensions:` key.
type Recommended struct {
	ID          string `yaml:"id" json:"id"`
	Label       string `yaml:"label" json:"label"`
	Description string `yaml:"description" json:"description"`
	Category    string `yaml:"category" json:"category"`
}

// MiseTool is one entry under a mise category's `tools:` list.
type MiseTool struct {
	ID          string `yaml:"id" json:"id"`
	Label       string `yaml:"label" json:"label"`
	Description string `yaml:"description" json:"description"`
}

// MiseCategory is one entry under the recommendations file's `mise:` key.
type MiseCategory struct {
	Category string     `yaml:"category" json:"category"`
	Tools    []MiseTool `yaml:"tools" json:"tools"`
}

// RecommendedFont is one entry under a fonts category's `fonts:` list.
// Either DirectURL (a font file as-is) or ZipURL+ZipEntrySuffix (a release
// zip, of which only the entry ending in ZipEntrySuffix is extracted) is
// set, never both. main.installRecommendedFont downloads through this
// shape directly — boot-time seeding (main.defaultFontSeedIDs) and a
// user-triggered click (POST /api/fonts/install) both just reference an
// entry here by ID rather than duplicating its source.
type RecommendedFont struct {
	ID          string `yaml:"id" json:"id"`
	Label       string `yaml:"label" json:"label"`
	Description string `yaml:"description" json:"description"`
	Weight      int    `yaml:"weight" json:"weight"`
	Style       string `yaml:"style" json:"style"`

	DirectURL      string `yaml:"directURL" json:"-"`
	DirectExt      string `yaml:"directExt" json:"-"`
	ZipURL         string `yaml:"zipURL" json:"-"`
	ZipEntrySuffix string `yaml:"zipEntrySuffix" json:"-"`
}

// FontCategory is one entry under the recommendations file's `fonts:` key.
type FontCategory struct {
	Category string            `yaml:"category" json:"category"`
	Fonts    []RecommendedFont `yaml:"fonts" json:"fonts"`
}

// recommendationsFile mirrors the full YAML document. Unknown top-level keys
// are ignored by yaml.Unmarshal, not errors.
type recommendationsFile struct {
	Extensions []Recommended  `yaml:"extensions"`
	Mise       []MiseCategory `yaml:"mise"`
	Fonts      []FontCategory `yaml:"fonts"`
}

// Recommendations is the parsed recommendations file, every top-level key.
type Recommendations struct {
	Extensions []Recommended
	Mise       []MiseCategory
	Fonts      []FontCategory
}

// LoadRecommendations reads overridePath if it exists, else defaultPath. If
// neither file exists, it returns an empty Recommendations rather than an
// error.
func LoadRecommendations(defaultPath, overridePath string) (Recommendations, error) {
	path := defaultPath
	if _, err := os.Stat(overridePath); err == nil {
		path = overridePath
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Recommendations{Extensions: []Recommended{}, Mise: []MiseCategory{}, Fonts: []FontCategory{}}, nil
		}
		return Recommendations{}, err
	}

	var f recommendationsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return Recommendations{}, err
	}
	if f.Extensions == nil {
		f.Extensions = []Recommended{}
	}
	if f.Mise == nil {
		f.Mise = []MiseCategory{}
	}
	if f.Fonts == nil {
		f.Fonts = []FontCategory{}
	}
	return Recommendations{Extensions: f.Extensions, Mise: f.Mise, Fonts: f.Fonts}, nil
}

const installTimeout = 60 * time.Second

var extensionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$`)

// ErrInvalidID is returned by Install when id isn't a well-formed
// `publisher.name` VS Code extension identifier. Without this check, an id
// like "--some-flag" passed as a bare exec.Command arg could be misparsed by
// code-server as a CLI flag instead of an extension identifier.
var ErrInvalidID = errors.New("id must be a valid publisher.name extension identifier")

// ValidateID reports whether id is a well-formed extension identifier.
func ValidateID(id string) error {
	if !extensionIDRe.MatchString(id) {
		return ErrInvalidID
	}
	return nil
}

func commonArgs(userDataDir, extensionsDir string) []string {
	return []string{
		"--user-data-dir=" + userDataDir,
		"--extensions-dir=" + extensionsDir,
	}
}

// ListInstalled shells out to `code-server --list-extensions` and returns
// the installed extension IDs.
func ListInstalled(ctx context.Context, binPath, userDataDir, extensionsDir string) ([]string, error) {
	args := append(commonArgs(userDataDir, extensionsDir), "--list-extensions")
	cmd := exec.CommandContext(ctx, binPath, args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("list-extensions: %w", err)
	}

	lines := strings.Split(string(out), "\n")
	result := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" {
			result = append(result, l)
		}
	}
	return result, nil
}

// Install shells out to `code-server --install-extension <id>`. Callers must
// call ValidateID first.
func Install(ctx context.Context, binPath, userDataDir, extensionsDir, id string) error {
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()

	args := append(commonArgs(userDataDir, extensionsDir), "--install-extension", id)
	cmd := exec.CommandContext(ctx, binPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	return nil
}

// Uninstall shells out to `code-server --uninstall-extension <id>` — same
// flag shape and CLI as --install-extension (confirmed against the official
// VS Code CLI docs, which code-server mirrors), so this is a near-exact copy
// of Install rather than something new. Callers must call ValidateID first.
// Per-extension *disable* (keep installed, just deactivate) deliberately
// isn't implemented alongside this — see extension-search-plan.md for why
// (no stable CLI flag or documented persisted-state format exists for it,
// unlike install/uninstall).
func Uninstall(ctx context.Context, binPath, userDataDir, extensionsDir, id string) error {
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()

	args := append(commonArgs(userDataDir, extensionsDir), "--uninstall-extension", id)
	cmd := exec.CommandContext(ctx, binPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	return nil
}
