// Package targetguard holds the security-critical core of "is this a safe
// reverse-proxy target" validation shared by internal/devproxy and
// internal/approutes — both let a user point a route at an arbitrary
// host:port, so both need the same never-opt-outable self-SSRF block. Kept
// as a single shared copy specifically because SelfHosts is the kind of
// list someone patches once (a new self-referential alias, say) and easily
// forgets to patch twice — see router/.claude/router-nginx-hardening-plan.md,
// Finding 1, for the original incident this guards against (a Dev Proxy
// route that could reach Caddy's own admin API).
package targetguard

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
)

// SelfHosts can never be a route target, even when a feature's own
// allow-external-targets env var is set — Caddy runs inside this same
// container, so a route targeting one of these is always a same-host SSRF
// attempt, never a legitimate use case.
var SelfHosts = map[string]bool{
	"localhost": true,
	"127.0.0.1": true,
	"::1":       true,
	"router":    true,
	"forward":   true,
}

var targetRe = regexp.MustCompile(`^[a-zA-Z0-9_.:\[\]-]+$`)

// ExtraAllowedHostsEnv widens both devproxy's and approutes' built-in
// allowedTargetHosts map with a comma-separated list of extra hostnames —
// e.g. a sibling project's compose overlay (see root CLAUDE.md's
// EXTRA_INCLUDE/roblox-studio-docker integration) attaching its own
// container to a network router can reach, without needing a router code
// change to route to it. Unlike allowExternalEnv (which drops the allowlist
// entirely), this stays within the same security model — it only adds
// specific known-safe hosts — so it's meant to be left set permanently in
// infra config, not used as an occasional debug escape hatch.
const ExtraAllowedHostsEnv = "ROUTER_EXTRA_ALLOWED_TARGET_HOSTS"

// WithExtraHosts returns a copy of base with any hostnames named in the
// comma-separated ExtraAllowedHostsEnv environment variable added (lower-
// cased, matching Validate's own host normalization).
func WithExtraHosts(base map[string]bool) map[string]bool {
	merged := make(map[string]bool, len(base))
	for h := range base {
		merged[h] = true
	}
	for _, h := range strings.Split(os.Getenv(ExtraAllowedHostsEnv), ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			merged[h] = true
		}
	}
	return merged
}

// Validate checks target is a plain host:port with no whitespace or
// Caddyfile syntax characters (braces, newlines) that could break out of a
// generated fragment, that it never points back at router itself
// (SelfHosts, no opt-out), and — unless the env var named by allowExternalEnv
// is "true" — that its host is a member of allowedHosts. featureLabel is
// spliced into error text only (e.g. "Dev Proxy", "App Route").
func Validate(target string, allowedHosts map[string]bool, allowExternalEnv, featureLabel string) error {
	if target == "" || !targetRe.MatchString(target) {
		return errors.New("target must be a plain host:port with no spaces or special characters")
	}

	host := target
	if h, _, err := net.SplitHostPort(target); err == nil {
		host = h
	}
	host = strings.ToLower(host)

	if SelfHosts[host] {
		return fmt.Errorf("target %q would point back at router itself - not a valid %s target", target, featureLabel)
	}

	if os.Getenv(allowExternalEnv) == "true" {
		return nil
	}
	if !allowedHosts[host] {
		names := make([]string, 0, len(allowedHosts))
		for h := range allowedHosts {
			names = append(names, h)
		}
		sort.Strings(names)
		return fmt.Errorf("target host %q is not a known code-docker-internal service (allowed: %s) - set %s=true to allow other targets", host, strings.Join(names, ", "), allowExternalEnv)
	}
	return nil
}
