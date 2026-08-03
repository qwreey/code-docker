// Package mise wraps the `mise` CLI (runtime/tool version manager) for
// webmanager's mise tab — install/uninstall/list/env, all via shell-out to
// real `mise` subcommands, mirroring internal/extensions/internal/claudecode's
// "CLI shell-out + structured JSON parsing" pattern. See
// webmanager/.claude/mise-plan.md for the verified CLI behavior this package
// is built against (real `mise` commands run and their actual output
// captured, including a live re-verification during implementation).
package mise

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// defaultBinPath is the fixed path mise installs itself to inside this
// image — config/code-runner.default.sh calls $HOME/.local/bin/mise
// directly (not a bare `mise` on PATH), because mise's own install script
// places itself outside the PATH shim it manages for other tools. $HOME is
// always /code in this image, per the rest of this codebase's convention of
// hardcoding that path rather than resolving it at runtime (see
// claudecode's ClaudeConfigDir default, sshkeys' SSHKeysDir default, etc.
// in config.go).
const defaultBinPath = "/code/.local/bin/mise"

// defaultHomeDir is used as GetEnv's -C target when no path is given, so
// the global env preview reflects $HOME's config rather than whatever
// directory the webmanager process happens to have as its cwd.
const defaultHomeDir = "/code"

// readTimeout bounds the quick, read-only subcommands (ls/env). Actual
// installs/uninstalls run as background jobs instead (see jobs.go) — doc-
// verified that install/uninstall can involve real download time, so they
// deliberately don't share this timeout.
const readTimeout = 15 * time.Second

// FindBinary resolves the `mise` binary path. override
// (WEBMANAGER_MISE_BINPATH) takes priority when non-empty; otherwise it
// falls back to the fixed defaultBinPath. Unlike claudecode.FindBinary,
// this never falls back to a bare PATH lookup — mise is deliberately kept
// off PATH inside this image (see defaultBinPath's doc comment). Either
// failing (override doesn't exist, or the fixed path doesn't exist) means
// "not installed" — ok is false, not an error, since that's a normal state
// for an instance that hasn't set up mise.
func FindBinary(override string) (path string, ok bool) {
	p := override
	if p == "" {
		p = defaultBinPath
	}
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		return "", false
	}
	return p, true
}

// toolIDRe/versionRe validate the two halves of a `TOOL@VERSION` mise
// argument before they ever reach exec.Command, mirroring
// internal/extensions's ValidateID (a leading `-` could otherwise be
// misparsed as a CLI flag). Tool ids may include a backend prefix
// (`npm:eslint`, `cargo:ripgrep`, `aqua:owner/repo`) per mise's own tool
// specifier syntax, so `:`/`/` are allowed there; version strings don't
// need those.
var (
	toolIDRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9@:/_.\-]*$`)
	versionRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.\-]*$`)
)

var (
	// ErrInvalidToolID is returned by ValidateToolID when id isn't a
	// well-formed mise tool identifier.
	ErrInvalidToolID = errors.New("id must be a safe mise tool identifier")
	// ErrInvalidVersion is returned by ValidateVersion when version isn't a
	// well-formed mise version string.
	ErrInvalidVersion = errors.New("version must be a safe mise version string")
)

// ValidateToolID reports whether id is safe to pass to exec.Command as part
// of a `TOOL@VERSION` argument.
func ValidateToolID(id string) error {
	if !toolIDRe.MatchString(id) {
		return ErrInvalidToolID
	}
	return nil
}

// ValidateVersion reports whether version is safe to pass to exec.Command
// as part of a `TOOL@VERSION` argument.
func ValidateVersion(version string) error {
	if !versionRe.MatchString(version) {
		return ErrInvalidVersion
	}
	return nil
}

// Source is one tool version entry's install source, as reported by
// `mise ls --json`.
type Source struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

// Tool is one installed/declared tool version. `mise ls --json` reports a
// map of tool name -> []entry; ListTools flattens that into this slice
// shape with Name attached, for a simpler frontend contract.
type Tool struct {
	Name             string  `json:"name"`
	Version          string  `json:"version"`
	RequestedVersion string  `json:"requestedVersion"`
	InstallPath      string  `json:"installPath"`
	Source           *Source `json:"source"`
	Installed        bool    `json:"installed"`
	Active           bool    `json:"active"`
}

// rawToolEntry mirrors one array entry of `mise ls --json`'s per-tool-name
// value, field-for-field (snake_case on the wire).
type rawToolEntry struct {
	Version          string  `json:"version"`
	RequestedVersion string  `json:"requested_version"`
	InstallPath      string  `json:"install_path"`
	Source           *Source `json:"source"`
	Installed        bool    `json:"installed"`
	Active           bool    `json:"active"`
}

// ListTools runs `mise ls --json`: global (`-g`) when path is empty, else
// project-scoped (`-C <path> --local`, that project's own mise.toml/
// .tool-versions only). Callers must have already validated path against
// the Projects cache (see internal/projects.Scanner.IsKnownPath) before
// calling this with a non-empty path — this function does not re-validate.
func ListTools(ctx context.Context, binPath, path string) ([]Tool, error) {
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	var args []string
	if path == "" {
		args = []string{"ls", "-g", "--json"}
	} else {
		args = []string{"ls", "-C", path, "--local", "--json"}
	}

	cmd := exec.CommandContext(ctx, binPath, args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var raw map[string][]rawToolEntry
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}

	names := make([]string, 0, len(raw))
	for name := range raw {
		names = append(names, name)
	}
	sort.Strings(names)

	tools := make([]Tool, 0, len(raw))
	for _, name := range names {
		for _, e := range raw[name] {
			tools = append(tools, Tool{
				Name:             name,
				Version:          e.Version,
				RequestedVersion: e.RequestedVersion,
				InstallPath:      e.InstallPath,
				Source:           e.Source,
				Installed:        e.Installed,
				Active:           e.Active,
			})
		}
	}
	return tools, nil
}

// GetLatestVersion runs `mise latest <toolID>`, which prints a single plain
// version string to stdout (not JSON, unlike ls/env/registry). Bounded by
// readTimeout — this is a quick lookup, not an install. toolID is validated
// via ValidateToolID before it ever reaches exec.Command, same flag-
// injection defense as everywhere else in this file.
func GetLatestVersion(ctx context.Context, binPath, toolID string) (string, error) {
	if err := ValidateToolID(toolID); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "latest", toolID)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// GetEnv runs `mise env --json` targeting path (or defaultHomeDir when path
// is empty, so the global view reflects $HOME rather than webmanager's own
// process cwd). Uses cmd.Output(), which only returns stdout on success —
// doc-verified that a WARN about a missing/unresolvable tool goes to
// stderr while stdout's JSON stays valid and exit code stays 0, so no
// separate stderr handling is needed here beyond what Output() already
// does.
func GetEnv(ctx context.Context, binPath, path string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	target := path
	if target == "" {
		target = defaultHomeDir
	}

	cmd := exec.CommandContext(ctx, binPath, "env", "-C", target, "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var env map[string]string
	if err := json.Unmarshal(out, &env); err != nil {
		return nil, err
	}
	return env, nil
}
