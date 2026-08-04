// Package devproxy manages per-expose Caddyfile fragments under
// /code/.caddy-adapter/managed/ — the "managed" half of the internal Caddy
// instance config/caddy-adapter.default.sh starts (see docs/dev-proxy.md).
// One expose (a dev server reverse-proxied out to a wildcard subdomain) is
// one *.caddy file, generated from a small structured template. Raw text
// edits are also supported (the CodeEditor fallback in the frontend) — this
// package doesn't require its own template shape, it just can't render a
// structured form back out of a fragment that doesn't match it.
//
// ManagedDir/CaddyfilePath/AdminAddr mirror the fixed layout
// caddy-adapter.default.sh seeds — kept as constants here (not config.go
// env vars) since there's exactly one correct value, same reasoning as that
// script hardcoding ADAPTER_DIR.
package devproxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	ManagedDir    = "/code/.caddy-adapter/managed"
	CaddyfilePath = "/code/.caddy-adapter/Caddyfile"
	AdminAddr     = "localhost:2019"
)

var (
	ErrExposeExists   = errors.New("expose already exists")
	ErrExposeNotFound = errors.New("expose not found")
)

// Expose is one dev-proxy entry — a subdomain (Name, under whatever
// CADDY_ADAPTER_DOMAIN is configured) reverse-proxied to Target, optionally
// splitting /api/* off to a separate APITarget, optionally required to pass
// GET /api/auth/verify first (see handlers_auth.go).
type Expose struct {
	Name        string `json:"name"`
	Target      string `json:"target"`
	APITarget   string `json:"apiTarget,omitempty"`
	RequireAuth bool   `json:"requireAuth"`
}

// Info is what List returns — the raw fragment text always, plus a
// best-effort structured parse (nil if the fragment doesn't match the exact
// shape Render produces, e.g. it was hand-edited via the raw editor).
type Info struct {
	Name       string  `json:"name"`
	Raw        string  `json:"raw"`
	Structured *Expose `json:"structured,omitempty"`
}

var nameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidateName checks name is a safe subdomain label — it's used both as a
// filename component (managedDir/name+".caddy") and as a Caddyfile `host`
// matcher value, so anything outside a strict RFC1123-label charset is
// rejected rather than escaped (same pattern as internal/dind's ValidateID).
func ValidateName(name string) error {
	if !nameRe.MatchString(name) {
		return errors.New("name must be a lowercase subdomain label (alphanumeric/hyphen, no leading/trailing hyphen)")
	}
	return nil
}

var targetRe = regexp.MustCompile(`^[a-zA-Z0-9_.:\[\]-]+$`)

// ValidateTarget checks target is a plain host:port with no whitespace or
// Caddyfile syntax characters (braces, newlines) that could break out of
// the generated fragment.
func ValidateTarget(target string) error {
	if target == "" || !targetRe.MatchString(target) {
		return errors.New("target must be a plain host:port with no spaces or special characters")
	}
	return nil
}

func path(name string) string {
	return filepath.Join(ManagedDir, name+".caddy")
}

// Render produces the Caddyfile fragment text for e, given the base domain
// (CADDY_ADAPTER_DOMAIN with its leading "*." stripped) and authTarget —
// webmanager's own bind address (Config.Addr, i.e. WEBMANAGER_ADDR, default
// "private:81") — not "localhost:81": webmanager binds to the `private`
// docker-network alias, not loopback, so forward_auth has to target that
// same address or Caddy gets a connection-refused 502. No preserve_host
// (`header_up Host {host}`) — deliberately left out, see docs/dev-proxy.md.
func Render(domain, authTarget string, e Expose) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@%s host %s.%s\n", e.Name, e.Name, domain)
	fmt.Fprintf(&b, "handle @%s {\n", e.Name)
	if e.RequireAuth {
		fmt.Fprintf(&b, "\tforward_auth %s {\n\t\turi /api/auth/verify\n\t}\n", authTarget)
	}
	if e.APITarget != "" {
		fmt.Fprintf(&b, "\thandle /api/* {\n\t\treverse_proxy %s\n\t}\n", e.APITarget)
		fmt.Fprintf(&b, "\thandle {\n\t\treverse_proxy %s\n\t}\n", e.Target)
	} else {
		fmt.Fprintf(&b, "\treverse_proxy %s\n", e.Target)
	}
	b.WriteString("}\n")
	return b.String()
}

// parseStructured attempts to recover an Expose from a fragment's raw text,
// by checking it line-for-line against what Render would have produced for
// some target/apiTarget/requireAuth combination (authTarget must match the
// value Render was called with — see List). Returns ok=false for anything
// that doesn't match exactly — a hand-edited fragment (or one written when
// WEBMANAGER_ADDR held a different value) just loses structured-form
// editing, it's never rejected or corrected.
func parseStructured(name, authTarget, content string) (Expose, bool) {
	lines := strings.Split(content, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) < 3 {
		return Expose{}, false
	}
	wantPrefix := fmt.Sprintf("@%s host %s.", name, name)
	if !strings.HasPrefix(lines[0], wantPrefix) {
		return Expose{}, false
	}
	if lines[1] != fmt.Sprintf("handle @%s {", name) {
		return Expose{}, false
	}
	if lines[len(lines)-1] != "}" {
		return Expose{}, false
	}
	body := lines[2 : len(lines)-1]
	e := Expose{Name: name}
	i := 0
	if i < len(body) && body[i] == fmt.Sprintf("\tforward_auth %s {", authTarget) {
		if i+2 >= len(body) || body[i+1] != "\t\turi /api/auth/verify" || body[i+2] != "\t}" {
			return Expose{}, false
		}
		e.RequireAuth = true
		i += 3
	}
	switch {
	case i < len(body) && body[i] == "\thandle /api/* {":
		if i+6 > len(body) {
			return Expose{}, false
		}
		if !strings.HasPrefix(body[i+1], "\t\treverse_proxy ") || body[i+2] != "\t}" || body[i+3] != "\thandle {" ||
			!strings.HasPrefix(body[i+4], "\t\treverse_proxy ") || body[i+5] != "\t}" {
			return Expose{}, false
		}
		e.APITarget = strings.TrimPrefix(body[i+1], "\t\treverse_proxy ")
		e.Target = strings.TrimPrefix(body[i+4], "\t\treverse_proxy ")
		i += 6
	case i < len(body) && strings.HasPrefix(body[i], "\treverse_proxy "):
		e.Target = strings.TrimPrefix(body[i], "\treverse_proxy ")
		i++
	default:
		return Expose{}, false
	}
	if i != len(body) {
		return Expose{}, false
	}
	return e, true
}

// List returns every managed expose, each with its raw text and (when it
// round-trips through Render) a structured parse. authTarget must be the
// current WEBMANAGER_ADDR-derived value (see Render) for that parse to
// succeed.
func List(authTarget string) ([]Info, error) {
	entries, err := os.ReadDir(ManagedDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Info{}, nil
		}
		return nil, err
	}
	result := make([]Info, 0, len(entries))
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".caddy") {
			continue
		}
		name := strings.TrimSuffix(ent.Name(), ".caddy")
		data, err := os.ReadFile(filepath.Join(ManagedDir, ent.Name()))
		if err != nil {
			continue
		}
		info := Info{Name: name, Raw: string(data)}
		if e, ok := parseStructured(name, authTarget, string(data)); ok {
			info.Structured = &e
		}
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func runCaddy(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "caddy", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	return nil
}

// writeAndValidate writes content for name, then validates the WHOLE
// Caddyfile tree (the top-level file imports managedDir/*.caddy, so this
// fragment is included) via `caddy adapt` — a lone fragment isn't valid
// Caddyfile syntax on its own, so validation has to happen at the tree
// level. On failure the previous content is restored (or the file removed,
// if this was a new expose) and reload is never called.
func writeAndValidate(ctx context.Context, name, content string) error {
	p := path(name)
	previous, hadPrevious := "", false
	if data, err := os.ReadFile(p); err == nil {
		previous, hadPrevious = string(data), true
	}
	if err := os.MkdirAll(ManagedDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		return err
	}
	if err := runCaddy(ctx, "adapt", "--config", CaddyfilePath, "--adapter", "caddyfile"); err != nil {
		if hadPrevious {
			_ = os.WriteFile(p, []byte(previous), 0o644)
		} else {
			_ = os.Remove(p)
		}
		return fmt.Errorf("invalid Caddyfile: %w", err)
	}
	return nil
}

// Reload re-adapts and hot-swaps the running Caddy instance's config —
// caddy-plan.md's confirmed-safe path (new config validated and loaded
// before the old one is torn down, auto-rollback on error, no dropped
// connections for unrelated exposes).
func Reload(ctx context.Context) error {
	return runCaddy(ctx, "reload", "--config", CaddyfilePath, "--adapter", "caddyfile", "--address", AdminAddr)
}

func validateExpose(e Expose) error {
	if err := ValidateName(e.Name); err != nil {
		return err
	}
	if err := ValidateTarget(e.Target); err != nil {
		return err
	}
	if e.APITarget != "" {
		if err := ValidateTarget(e.APITarget); err != nil {
			return err
		}
	}
	return nil
}

// Create adds a new expose. domain is CADDY_ADAPTER_DOMAIN with its leading
// "*." stripped, authTarget is webmanager's own bind address (see Render).
func Create(ctx context.Context, domain, authTarget string, e Expose) error {
	if err := validateExpose(e); err != nil {
		return err
	}
	if _, err := os.Stat(path(e.Name)); err == nil {
		return ErrExposeExists
	}
	if err := writeAndValidate(ctx, e.Name, Render(domain, authTarget, e)); err != nil {
		return err
	}
	return Reload(ctx)
}

// UpdateStructured overwrites name's fragment with a freshly rendered
// structured template.
func UpdateStructured(ctx context.Context, domain, authTarget string, e Expose) error {
	if err := validateExpose(e); err != nil {
		return err
	}
	if _, err := os.Stat(path(e.Name)); err != nil {
		return ErrExposeNotFound
	}
	if err := writeAndValidate(ctx, e.Name, Render(domain, authTarget, e)); err != nil {
		return err
	}
	return Reload(ctx)
}

// UpdateRaw overwrites name's fragment with arbitrary Caddyfile text (the
// CodeEditor fallback) — not run through validateExpose/Render at all,
// `caddy adapt` inside writeAndValidate is the only gate.
func UpdateRaw(ctx context.Context, name, raw string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	if _, err := os.Stat(path(name)); err != nil {
		return ErrExposeNotFound
	}
	if err := writeAndValidate(ctx, name, raw); err != nil {
		return err
	}
	return Reload(ctx)
}

// Delete removes name's fragment and reloads.
func Delete(ctx context.Context, name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	p := path(name)
	if _, err := os.Stat(p); err != nil {
		return ErrExposeNotFound
	}
	if err := os.Remove(p); err != nil {
		return err
	}
	if err := runCaddy(ctx, "adapt", "--config", CaddyfilePath, "--adapter", "caddyfile"); err != nil {
		return fmt.Errorf("remaining Caddyfile invalid after delete: %w", err)
	}
	return Reload(ctx)
}
