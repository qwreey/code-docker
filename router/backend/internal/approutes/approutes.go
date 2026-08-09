// Package approutes manages per-app Caddyfile fragments under
// /var/lib/code-docker-router/caddy-adapter/apps/ — "App Routes", a sibling
// of internal/devproxy that answers a different question. Dev Proxy routes
// by Host header (a subdomain you point at router); App Routes routes by
// **path**, regardless of Host (`/app/<name>/...`, prefix stripped
// automatically by Caddy's own `handle_path`), for the case where router
// doesn't know in advance what Host an outer/external reverse proxy will
// use, or is deployed generically in front of different internal setups.
// See docs/app-routes.md.
//
// One app is one *.caddy file in ManagedDir, generated from a small
// structured template (Render) — same round-trip/raw-fallback shape as
// devproxy.Expose, deliberately much flatter: there is exactly one path
// shape per app, so there's nothing for devproxy.Route's
// Path/StripPrefix/RewritePrefix/Mode fields to do here. Reuses
// devproxy.CaddyfilePath/AdminAddr (same running Caddy instance, same
// top-level Caddyfile, same admin socket - see
// router/config/caddy-adapter/caddy-adapter.default.sh) and
// devproxy.TinyauthTarget/TinyauthVerifyURI/ValidateName rather than
// redefining them, since all four are fixed-layout constants with exactly
// one correct value shared by both features, not something either package
// owns exclusively.
package approutes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"router/internal/devproxy"
	"router/internal/targetguard"
)

// ManagedDir is App Routes' own fragment directory - a sibling of
// devproxy.ManagedDir under the same caddy-adapter state root, imported by
// caddy-adapter.default.sh's own `apps/*.caddy` glob into a separate
// (path-matched, not Host-matched) site block.
const ManagedDir = "/var/lib/code-docker-router/caddy-adapter/apps"

var (
	ErrAppExists   = errors.New("app already exists")
	ErrAppNotFound = errors.New("app not found")
	// ErrReloadFailed wraps a Reload failure that happens AFTER the
	// fragment was already written and validated - see devproxy's
	// identical ErrReloadFailed for the full reasoning.
	ErrReloadFailed = errors.New("saved, but reloading Caddy failed")
)

// App is one App Routes entry — Name is both the managed *.caddy filename
// and the `/app/<name>/*` path segment it answers for, so it shares
// devproxy.ValidateName's RFC1123-label constraint (safe as a filename
// component; unlike devproxy.Expose.Host there's no separate external
// hostname concept here at all - that's the whole point of being
// Host-agnostic). RequireAuth gates the app behind tinyauth, same mechanism
// as a Dev Proxy route.
type App struct {
	Name        string `json:"name"`
	Target      string `json:"target"`
	RequireAuth bool   `json:"requireAuth"`
}

// Info is what List returns — the raw fragment text always, plus a
// best-effort structured parse (nil if the fragment doesn't match the exact
// shape Render produces, e.g. it was hand-edited via the raw editor).
type Info struct {
	Name       string `json:"name"`
	Raw        string `json:"raw"`
	Structured *App   `json:"structured,omitempty"`
}

// allowedTargetHosts mirrors devproxy's own allowlist - App Routes reaches
// the same internal services Dev Proxy does, most commonly code-docker
// itself (the shipped default app, see caddy-adapter.default.sh's seed
// block, targets exactly this).
var allowedTargetHosts = map[string]bool{
	"code-docker": true,
	"dind":        true,
}

// ValidateTarget delegates to targetguard (shared with devproxy) for the
// security-critical self-SSRF/self-host block, with App Routes' own
// allowlist/env-var/error-text identity.
func ValidateTarget(target string) error {
	return targetguard.Validate(target, allowedTargetHosts, "APPROUTES_ALLOW_EXTERNAL_TARGETS", "App Route")
}

func path(name string) string {
	return filepath.Join(ManagedDir, name+".caddy")
}

// locationRewriteSearch/locationRewriteReplace rewrite an upstream's 3xx
// `Location` response header back into the /app/<name>/ namespace. Caddy's
// `handle_path` strips /app/<name> off the *request* path before it ever
// reaches the target, but a target that issues an absolute-path redirect
// (nginx's `return 301 /manager/;`, which nginx itself expands to a full
// `http://<host>/manager/` URL) has no idea it was reached through a
// stripped prefix - without this, that redirect sends the browser to
// /manager/ directly, dropping the /app/<name> prefix entirely and
// escaping the app's own routing. Confirmed live: Caddy's reverse_proxy
// header_down directive supports a <find> <replace> regex form (Go regexp,
// $1-style backreferences via ${1}) specifically for this. This only
// rewrites the Location header itself - it can't fix root-absolute paths
// baked into an app's own HTML/JS (e.g. a Vite build's `base` setting), a
// genuinely harder problem (would need response-body rewriting) that's out
// of scope here, same as Dev Proxy's own documented preserve_host tradeoffs.
const locationRewriteSearch = `^(https?://[^/]+)/`

func locationRewriteReplace(name string) string {
	return fmt.Sprintf("${1}/app/%s/", name)
}

// Render produces the Caddyfile fragment text for a. Must stay byte-for-byte
// in sync with caddy-adapter.default.sh's own seed block for the default
// "code" app - both are read by parseStructured, and the shell seed exists
// purely to get an equivalent fragment on disk before Go ever runs.
func Render(a App) string {
	var b strings.Builder
	fmt.Fprintf(&b, "handle_path /app/%s/* {\n", a.Name)
	if a.RequireAuth {
		fmt.Fprintf(&b, "\tforward_auth %s {\n\t\turi %s\n\t}\n", devproxy.TinyauthTarget, devproxy.TinyauthVerifyURI)
	}
	fmt.Fprintf(&b, "\treverse_proxy %s {\n", a.Target)
	fmt.Fprintf(&b, "\t\theader_down Location %q %q\n", locationRewriteSearch, locationRewriteReplace(a.Name))
	b.WriteString("\t}\n")
	b.WriteString("}\n")
	return b.String()
}

// parseStructured attempts to recover an App from a fragment's raw text, by
// checking it line-for-line against what Render would have produced. Returns
// ok=false for anything that doesn't match exactly (e.g. hand-edited via the
// raw editor) - it just loses structured-form editing, never rejected.
func parseStructured(name, content string) (App, bool) {
	lines := strings.Split(content, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	wantHeader := fmt.Sprintf("handle_path /app/%s/* {", name)
	if len(lines) < 3 || lines[0] != wantHeader || lines[len(lines)-1] != "}" {
		return App{}, false
	}
	body := lines[1 : len(lines)-1]
	a := App{Name: name}
	i := 0
	wantForwardAuth := fmt.Sprintf("\tforward_auth %s {", devproxy.TinyauthTarget)
	if i < len(body) && body[i] == wantForwardAuth {
		wantURI := "\t\turi " + devproxy.TinyauthVerifyURI
		if i+2 >= len(body) || body[i+1] != wantURI || body[i+2] != "\t}" {
			return App{}, false
		}
		a.RequireAuth = true
		i += 3
	}
	if i >= len(body) || !strings.HasPrefix(body[i], "\treverse_proxy ") || !strings.HasSuffix(body[i], " {") {
		return App{}, false
	}
	a.Target = strings.TrimSuffix(strings.TrimPrefix(body[i], "\treverse_proxy "), " {")
	i++
	wantHeaderDown := fmt.Sprintf("\t\theader_down Location %q %q", locationRewriteSearch, locationRewriteReplace(name))
	if i >= len(body) || body[i] != wantHeaderDown {
		return App{}, false
	}
	i++
	if i >= len(body) || body[i] != "\t}" {
		return App{}, false
	}
	i++
	if i != len(body) {
		return App{}, false
	}
	return a, true
}

// List returns every managed app, each with its raw text and (when it
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
		if a, ok := parseStructured(name, string(data)); ok {
			info.Structured = &a
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
// Caddyfile tree (the top-level file imports ManagedDir/*.caddy alongside
// devproxy's own managed dir, so this fragment is included) via `caddy
// adapt` - a lone fragment isn't valid Caddyfile syntax on its own. On
// failure the previous content is restored (or the file removed, if this
// was a new app) and reload is never called. Identical logic to
// devproxy.writeAndValidate - not shared, since it's pure filesystem/exec
// plumbing rather than security-critical policy (unlike targetguard).
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
	if err := runCaddy(ctx, "adapt", "--config", devproxy.CaddyfilePath, "--adapter", "caddyfile"); err != nil {
		if hadPrevious {
			_ = os.WriteFile(p, []byte(previous), 0o644)
		} else {
			_ = os.Remove(p)
		}
		return fmt.Errorf("invalid Caddyfile: %w", err)
	}
	return nil
}

// Reload re-adapts and hot-swaps the running Caddy instance's config -
// same confirmed-safe path devproxy.Reload uses (new config validated and
// loaded before the old one is torn down, auto-rollback on error, no
// dropped connections for unrelated apps/exposes).
func Reload(ctx context.Context) error {
	return runCaddy(ctx, "reload", "--config", devproxy.CaddyfilePath, "--adapter", "caddyfile", "--address", devproxy.AdminAddr)
}

// reloadAfterWrite calls Reload and, on failure, wraps the error as
// ErrReloadFailed - see devproxy's identical helper for the full reasoning.
func reloadAfterWrite(ctx context.Context) error {
	if err := Reload(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrReloadFailed, err)
	}
	return nil
}

func validateApp(a App) error {
	if err := devproxy.ValidateName(a.Name); err != nil {
		return err
	}
	if err := ValidateTarget(a.Target); err != nil {
		return err
	}
	return nil
}

// Create adds a new app.
func Create(ctx context.Context, a App) error {
	if err := validateApp(a); err != nil {
		return err
	}
	if _, err := os.Stat(path(a.Name)); err == nil {
		return ErrAppExists
	}
	if err := writeAndValidate(ctx, a.Name, Render(a)); err != nil {
		return err
	}
	return reloadAfterWrite(ctx)
}

// UpdateStructured overwrites oldName's fragment with a freshly rendered
// structured template for a. If a.Name differs from oldName this also
// renames the app (new filename, new /app/<name>/* path): the new file is
// written and validated first, and only removes oldName's file after that
// succeeds - so a bad rename never leaves the app missing.
func UpdateStructured(ctx context.Context, oldName string, a App) error {
	if err := validateApp(a); err != nil {
		return err
	}
	if _, err := os.Stat(path(oldName)); err != nil {
		return ErrAppNotFound
	}
	renaming := a.Name != oldName
	if renaming {
		if _, err := os.Stat(path(a.Name)); err == nil {
			return ErrAppExists
		}
	}
	if err := writeAndValidate(ctx, a.Name, Render(a)); err != nil {
		return err
	}
	if renaming {
		if err := os.Remove(path(oldName)); err != nil {
			return err
		}
	}
	return reloadAfterWrite(ctx)
}

// UpdateRaw overwrites name's fragment with arbitrary Caddyfile text (the
// raw-editor fallback) - not run through validateApp/Render at all, `caddy
// adapt` inside writeAndValidate is the only gate.
func UpdateRaw(ctx context.Context, name, raw string) error {
	if err := devproxy.ValidateName(name); err != nil {
		return err
	}
	if _, err := os.Stat(path(name)); err != nil {
		return ErrAppNotFound
	}
	if err := writeAndValidate(ctx, name, raw); err != nil {
		return err
	}
	return reloadAfterWrite(ctx)
}

// Delete removes name's fragment and reloads.
func Delete(ctx context.Context, name string) error {
	if err := devproxy.ValidateName(name); err != nil {
		return err
	}
	p := path(name)
	if _, err := os.Stat(p); err != nil {
		return ErrAppNotFound
	}
	if err := os.Remove(p); err != nil {
		return err
	}
	if err := runCaddy(ctx, "adapt", "--config", devproxy.CaddyfilePath, "--adapter", "caddyfile"); err != nil {
		return fmt.Errorf("remaining Caddyfile invalid after delete: %w", err)
	}
	return reloadAfterWrite(ctx)
}
