// Package devproxy manages per-expose Caddyfile fragments under
// /var/lib/code-docker-router/caddy-adapter/managed/ — the "managed" half of
// the internal Caddy instance router/config/caddy-adapter/
// caddy-adapter.default.sh starts. Moved here from webmanager/backend
// (see .claude/functional-router-plan.md's "Dev Proxy Caddy도
// router로 이관") — near-verbatim, with one real behavior change: RequireAuth
// routes now forward-auth against tinyauth (router's own forward-auth
// service, see docker-compose.yml's code-docker-tinyauth) instead of
// webmanager's `GET /api/auth/verify`, since webmanager's authgate stays
// scoped to webmanager's own Terminal/File-Manager/Logs only.
//
// One expose (a dev server reverse-proxied out to a wildcard subdomain) is
// one *.caddy file, generated from a small structured template. Raw text
// edits are also supported (the CodeEditor fallback in the frontend) — this
// package doesn't require its own template shape, it just can't render a
// structured form back out of a fragment that doesn't match it.
//
// ManagedDir/CaddyfilePath/AdminAddr/TinyauthTarget/TinyauthVerifyURI mirror
// the fixed layout caddy-adapter.default.sh and docker-compose.yml's
// tinyauth service seed — kept as constants here (not config.go env vars)
// since there's exactly one correct value, same reasoning as that script
// hardcoding ADAPTER_DIR.
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
	ManagedDir    = "/var/lib/code-docker-router/caddy-adapter/managed"
	CaddyfilePath = "/var/lib/code-docker-router/caddy-adapter/Caddyfile"
	AdminAddr     = "localhost:2019"

	// tinyauth's own compose service/alias + the forward_auth verify path
	// its Caddy integration docs specify - see docker-compose.yml's
	// code-docker-tinyauth service.
	TinyauthTarget    = "tinyauth:3000"
	TinyauthVerifyURI = "/api/auth/caddy"
)

var (
	ErrExposeExists   = errors.New("expose already exists")
	ErrExposeNotFound = errors.New("expose not found")
)

// Expose is one dev-proxy entry — an internal identifier (Name, used only
// for the managed *.caddy filename and the Caddyfile `@name` matcher token)
// bound to Host, the full external hostname it responds to (e.g.
// "dev.example.com", or "*.staging.example.com" for a one-label wildcard —
// Caddy's own host-matcher wildcard syntax, passed through as-is). There is
// no shared base domain: the top-level Caddyfile listens for any Host (see
// router/config/caddy-adapter/caddy-adapter.default.sh), so different
// exposes are free to answer for entirely unrelated domains — the outer
// reverse proxy deciding what reaches this container is the only thing that
// actually restricts which hosts show up here. Split into an ordered list
// of Routes, each reverse-proxied independently. An Expose with no routes
// yet (just created, no route added) renders as a plain 404 placeholder.
type Expose struct {
	Name   string  `json:"name"`
	Host   string  `json:"host"`
	Routes []Route `json:"routes"`
}

// Route is one path-matched reverse-proxy rule inside an Expose's subdomain
// block. Path empty means "match everything" (rendered without a matcher
// argument, Caddy's own way of writing a catch-all handle/route block).
// Mode picks the wrapping Caddy directive — "route" (unconditional, runs
// regardless of whether an earlier block in the same handle already matched)
// vs "handle" (mutually exclusive, first match wins) — the two differ in
// exactly the way Caddy itself defines them, deliberately exposed as-is
// rather than reinterpreted, since routing this flexibly is the whole point.
// StripPrefix/RewritePrefix are free-text and independent of each other:
// StripPrefix removes a literal prefix from the request path
// (`uri strip_prefix <value>`) before proxying; RewritePrefix prepends a
// literal prefix to whatever path remains (`rewrite * <value>{uri}`) — e.g.
// matching "/api/*", stripping "/api", then rewriting with "/v1/api" turns
// "/api/foo" into "/v1/api/foo" on the way to Target. RequireAuth gates just
// this route (not the whole subdomain) behind tinyauth.
type Route struct {
	Path          string `json:"path,omitempty"`
	Target        string `json:"target"`
	StripPrefix   string `json:"stripPrefix,omitempty"`
	RewritePrefix string `json:"rewritePrefix,omitempty"`
	Mode          string `json:"mode"`
	RequireAuth   bool   `json:"requireAuth"`
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

// ValidateName checks name is a safe internal identifier — it's used both as
// a filename component (managedDir/name+".caddy") and as a Caddyfile `@name`
// matcher token, so anything outside a strict RFC1123-label charset is
// rejected rather than escaped (same pattern as internal/dind's ValidateID).
// It is not the external hostname — see ValidateHost for that.
func ValidateName(name string) error {
	if !nameRe.MatchString(name) {
		return errors.New("name must be a lowercase label (alphanumeric/hyphen, no leading/trailing hyphen)")
	}
	return nil
}

var hostRe = regexp.MustCompile(`^[a-zA-Z0-9*.-]+$`)

// ValidateHost checks host is a safe Caddyfile `host` matcher argument — a
// plain hostname, optionally with a leading "*." wildcard label (Caddy's own
// host-matcher wildcard syntax). Dots are allowed here (unlike ValidateName)
// since this is a real external domain, not an internal identifier.
func ValidateHost(host string) error {
	if host == "" || !hostRe.MatchString(host) {
		return errors.New("host must be a plain hostname (letters, digits, dots, hyphens, optional leading \"*.\")")
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

// pathLikeRe covers Path/StripPrefix/RewritePrefix — all three are spliced
// directly into generated Caddyfile lines (as a matcher argument or a bare
// directive argument), so the charset is restricted to what Caddy path
// syntax actually needs, same reasoning as ValidateTarget.
var pathLikeRe = regexp.MustCompile(`^[a-zA-Z0-9_.\-/*]*$`)

func validatePathLike(field, value string) error {
	if !pathLikeRe.MatchString(value) {
		return fmt.Errorf("%s must contain only letters, digits, and . _ - / *", field)
	}
	return nil
}

func path(name string) string {
	return filepath.Join(ManagedDir, name+".caddy")
}

// Render produces the Caddyfile fragment text for e. No preserve_host
// (`header_up Host {host}`) — deliberately left out, see docs/dev-proxy.md.
func Render(e Expose) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@%s host %s\n", e.Name, e.Host)
	fmt.Fprintf(&b, "handle @%s {\n", e.Name)
	if len(e.Routes) == 0 {
		// No routes yet (subdomain just created) — a placeholder response
		// keeps the fragment valid Caddyfile rather than an empty block.
		b.WriteString("\trespond 404\n")
	}
	for _, rt := range e.Routes {
		renderRoute(&b, rt)
	}
	b.WriteString("}\n")
	return b.String()
}

func renderRoute(b *strings.Builder, rt Route) {
	directive := "handle"
	if rt.Mode == "route" {
		directive = "route"
	}
	if rt.Path != "" {
		fmt.Fprintf(b, "\t%s %s {\n", directive, rt.Path)
	} else {
		fmt.Fprintf(b, "\t%s {\n", directive)
	}
	if rt.RequireAuth {
		fmt.Fprintf(b, "\t\tforward_auth %s {\n\t\t\turi %s\n\t\t}\n", TinyauthTarget, TinyauthVerifyURI)
	}
	if rt.StripPrefix != "" {
		fmt.Fprintf(b, "\t\turi strip_prefix %s\n", rt.StripPrefix)
	}
	if rt.RewritePrefix != "" {
		fmt.Fprintf(b, "\t\trewrite * %s{uri}\n", rt.RewritePrefix)
	}
	fmt.Fprintf(b, "\t\treverse_proxy %s\n", rt.Target)
	b.WriteString("\t}\n")
}

// parseStructured attempts to recover an Expose from a fragment's raw text,
// by checking it line-for-line against what Render would have produced for
// some route list. Returns ok=false for anything that doesn't match exactly
// — a hand-edited fragment just loses structured-form editing, it's never
// rejected or corrected.
func parseStructured(name, content string) (Expose, bool) {
	lines := strings.Split(content, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) < 3 {
		return Expose{}, false
	}
	wantHostPrefix := fmt.Sprintf("@%s host ", name)
	if !strings.HasPrefix(lines[0], wantHostPrefix) {
		return Expose{}, false
	}
	host := strings.TrimPrefix(lines[0], wantHostPrefix)
	if lines[1] != fmt.Sprintf("handle @%s {", name) {
		return Expose{}, false
	}
	if lines[len(lines)-1] != "}" {
		return Expose{}, false
	}
	body := lines[2 : len(lines)-1]
	if len(body) == 1 && body[0] == "\trespond 404" {
		return Expose{Name: name, Host: host, Routes: []Route{}}, true
	}
	e := Expose{Name: name, Host: host, Routes: []Route{}}
	i := 0
	for i < len(body) {
		rt, next, ok := parseRoute(body, i)
		if !ok {
			return Expose{}, false
		}
		e.Routes = append(e.Routes, rt)
		i = next
	}
	return e, true
}

var routeHeaderRe = regexp.MustCompile(`^\t(route|handle)(?: (.+))? \{$`)

// parseRoute recovers one Route starting at body[i] (a "\troute ... {" or
// "\thandle ... {" line), returning the index just past its closing "\t}".
func parseRoute(body []string, i int) (Route, int, bool) {
	if i >= len(body) {
		return Route{}, i, false
	}
	m := routeHeaderRe.FindStringSubmatch(body[i])
	if m == nil {
		return Route{}, i, false
	}
	rt := Route{Mode: m[1], Path: m[2]}
	i++
	wantForwardAuth := fmt.Sprintf("\t\tforward_auth %s {", TinyauthTarget)
	if i < len(body) && body[i] == wantForwardAuth {
		wantURI := "\t\t\turi " + TinyauthVerifyURI
		if i+2 >= len(body) || body[i+1] != wantURI || body[i+2] != "\t\t}" {
			return Route{}, i, false
		}
		rt.RequireAuth = true
		i += 3
	}
	if i < len(body) && strings.HasPrefix(body[i], "\t\turi strip_prefix ") {
		rt.StripPrefix = strings.TrimPrefix(body[i], "\t\turi strip_prefix ")
		i++
	}
	if i < len(body) && strings.HasPrefix(body[i], "\t\trewrite * ") && strings.HasSuffix(body[i], "{uri}") {
		rt.RewritePrefix = strings.TrimSuffix(strings.TrimPrefix(body[i], "\t\trewrite * "), "{uri}")
		i++
	}
	if i >= len(body) || !strings.HasPrefix(body[i], "\t\treverse_proxy ") {
		return Route{}, i, false
	}
	rt.Target = strings.TrimPrefix(body[i], "\t\treverse_proxy ")
	i++
	if i >= len(body) || body[i] != "\t}" {
		return Route{}, i, false
	}
	return rt, i + 1, true
}

// List returns every managed expose, each with its raw text and (when it
// round-trips through Render) a structured parse.
func List() ([]Info, error) {
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
		if e, ok := parseStructured(name, string(data)); ok {
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
	if err := ValidateHost(e.Host); err != nil {
		return err
	}
	for _, rt := range e.Routes {
		if err := validatePathLike("path", rt.Path); err != nil {
			return err
		}
		if err := ValidateTarget(rt.Target); err != nil {
			return err
		}
		if err := validatePathLike("stripPrefix", rt.StripPrefix); err != nil {
			return err
		}
		if err := validatePathLike("rewritePrefix", rt.RewritePrefix); err != nil {
			return err
		}
		if rt.Mode != "route" && rt.Mode != "handle" {
			return errors.New("route mode must be \"route\" or \"handle\"")
		}
	}
	return nil
}

// Create adds a new expose.
func Create(ctx context.Context, e Expose) error {
	if err := validateExpose(e); err != nil {
		return err
	}
	if _, err := os.Stat(path(e.Name)); err == nil {
		return ErrExposeExists
	}
	if err := writeAndValidate(ctx, e.Name, Render(e)); err != nil {
		return err
	}
	return Reload(ctx)
}

// UpdateStructured overwrites oldName's fragment with a freshly rendered
// structured template for e. If e.Name differs from oldName this also
// renames the expose (new filename, new Caddyfile @matcher token): the new
// file is written and validated first, and only removes oldName's file
// after that succeeds — so a bad rename never leaves the expose missing.
func UpdateStructured(ctx context.Context, oldName string, e Expose) error {
	if err := validateExpose(e); err != nil {
		return err
	}
	if _, err := os.Stat(path(oldName)); err != nil {
		return ErrExposeNotFound
	}
	renaming := e.Name != oldName
	if renaming {
		if _, err := os.Stat(path(e.Name)); err == nil {
			return ErrExposeExists
		}
	}
	if err := writeAndValidate(ctx, e.Name, Render(e)); err != nil {
		return err
	}
	if renaming {
		if err := os.Remove(path(oldName)); err != nil {
			return err
		}
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
