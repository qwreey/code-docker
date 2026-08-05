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
	"sync"
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

// registryCacheTTL bounds how long a `mise registry --json` snapshot is
// reused before the CLI is invoked again. The registry (995 entries as of
// mise 2026.7.15) is effectively static within a run — this exists only so
// a long-lived webmanager process eventually notices new tools a mise
// self-update adds, not because the shell-out itself is slow.
const registryCacheTTL = 6 * time.Hour

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
//
// The `-g` global case only reports tools declared in the global mise
// config — a tool installed via a bare `mise install` that was never
// `use -g`'d never shows up here at all (confirmed against a real `mise`:
// it's simply absent from `-g`'s output, not present-with-installed:false).
// handleClaudeMiseVersion relies on exactly that narrower "is this actually
// managed by mise's global config" signal, so this function's `-g` behavior
// stays as-is; ListInstalledTools below is the broader query for callers
// that want every install regardless of config membership (the mise tab's
// own tools list).
func ListTools(ctx context.Context, binPath, path string) ([]Tool, error) {
	var args []string
	if path == "" {
		args = []string{"ls", "-g", "--json"}
	} else {
		args = []string{"ls", "-C", path, "--local", "--json"}
	}
	return runList(ctx, binPath, args)
}

// ListInstalledTools runs `mise ls --json -C <defaultHomeDir>` (no `-g`) —
// a superset of ListTools(ctx, bin, "")'s output that also includes tools
// installed via a bare `mise install` that were never added to the global
// config (those entries come back with Active=false and a nil Source,
// since they aren't tied to any config file). `-C <defaultHomeDir>` pins
// the directory context the same way GetEnv does, so this can't
// accidentally pick up some unrelated project's local mise.toml if
// webmanager's own process cwd ever changes.
func ListInstalledTools(ctx context.Context, binPath string) ([]Tool, error) {
	return runList(ctx, binPath, []string{"ls", "-C", defaultHomeDir, "--json"})
}

func runList(ctx context.Context, binPath string, args []string) ([]Tool, error) {
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

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

// RegistryEntry mirrors one `mise registry --json` array entry.
type RegistryEntry struct {
	Short       string   `json:"short"`
	Backends    []string `json:"backends"`
	Description string   `json:"description"`
	Aliases     []string `json:"aliases"`
}

var registryCache struct {
	mu        sync.Mutex
	entries   []RegistryEntry
	fetchedAt time.Time
}

// getRegistry returns the full `mise registry --json` list, served from
// registryCache when a fetch happened within registryCacheTTL. Concurrent
// cache-miss callers may each trigger their own shell-out (no singleflight)
// — acceptable at this scale, not worth the extra machinery.
func getRegistry(ctx context.Context, binPath string) ([]RegistryEntry, error) {
	registryCache.mu.Lock()
	if registryCache.entries != nil && time.Since(registryCache.fetchedAt) < registryCacheTTL {
		entries := registryCache.entries
		registryCache.mu.Unlock()
		return entries, nil
	}
	registryCache.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "registry", "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var entries []RegistryEntry
	if err := json.Unmarshal(out, &entries); err != nil {
		return nil, err
	}

	registryCache.mu.Lock()
	registryCache.entries = entries
	registryCache.fetchedAt = time.Now()
	registryCache.mu.Unlock()

	return entries, nil
}

// SearchRegistry returns every registry entry whose short name, aliases, or
// description contains query (case-insensitive substring match). Callers
// are responsible for enforcing their own minimum query length — this
// function runs the match unconditionally, including for an empty query
// (which matches everything).
func SearchRegistry(ctx context.Context, binPath, query string) ([]RegistryEntry, error) {
	entries, err := getRegistry(ctx, binPath)
	if err != nil {
		return nil, err
	}

	q := strings.ToLower(query)
	matches := make([]RegistryEntry, 0)
	for _, e := range entries {
		if strings.Contains(strings.ToLower(e.Short), q) || strings.Contains(strings.ToLower(e.Description), q) {
			matches = append(matches, e)
			continue
		}
		for _, alias := range e.Aliases {
			if strings.Contains(strings.ToLower(alias), q) {
				matches = append(matches, e)
				break
			}
		}
	}
	return matches, nil
}

// rawRemoteVersion mirrors one `mise ls-remote --json` array entry.
// created_at is intentionally not kept — doc-verified it's an unreliable
// placeholder for older versions (many share the exact same timestamp), so
// it's not fit to show a user; the array's own order (ascending) is the
// only ordering signal ListRemoteVersions passes on.
type rawRemoteVersion struct {
	Version string `json:"version"`
}

// ListRemoteVersions runs `mise ls-remote <toolID> --json` and returns the
// available versions in mise's own (ascending) order. Deliberately
// uncached unlike SearchRegistry's registry snapshot — doc-measured at
// under 0.3s even cold (mise does its own internal caching, see
// `mise cache clean`), well inside readTimeout, so there's no latency
// problem to solve here.
func ListRemoteVersions(ctx context.Context, binPath, toolID string) ([]string, error) {
	if err := ValidateToolID(toolID); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, "ls-remote", toolID, "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var raw []rawRemoteVersion
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}

	versions := make([]string, len(raw))
	for i, v := range raw {
		versions[i] = v.Version
	}
	return versions, nil
}
