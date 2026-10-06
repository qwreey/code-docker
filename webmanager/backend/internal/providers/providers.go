// Package providers lets a sibling project attached through EXTRA_INCLUDE
// (code-docker-chrome, roblox-studio-docker, ...) show its own small
// management page inside webmanager. The project declares the page with one
// env var on the code-docker service; webmanager lists it as a tab and
// reverse-proxies /providers/<id>/ to it, because the browser can only reach
// code-docker's own nginx, never a container on code-docker-internal.
//
// The provider page is served on webmanager's own origin, so its scripts run
// with the same reach as webmanager's: it is trusted exactly as much as the
// compose overlay that declared it. That is why the declaration comes only
// from the container's environment (host-side compose access), and why the
// whole route sits behind the password gate.
package providers

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"

	"webmanager/internal/authgate"
)

// EnvPrefix is scanned once at startup. One env var per provider rather than
// one delimited list: each provider's compose overlay merges `environment:`
// onto the code-docker service, and two overlays writing the same key would
// overwrite each other. Same reasoning as WEBMANAGER_MANIFEST_SHORTCUT_*.
//
// Value format: "<Title>|<URL>".
const EnvPrefix = "WEBMANAGER_PROVIDER_"

// URLPrefix is where the proxy is mounted on webmanager's own mux.
const URLPrefix = "/providers/"

// BrowserBase is where nginx mounts webmanager (config/nginx/
// nginx.default.conf's `location /manager/`, which strips it before the
// request arrives here). Needed only to tell a provider the prefix the
// browser actually sees, since that is not recoverable from the request.
const BrowserBase = "/manager"

// Provider is one parsed WEBMANAGER_PROVIDER_* entry.
type Provider struct {
	// ID is the env var's suffix lowercased with "_" turned into "-", so it
	// is unique by construction and safe as a path segment.
	ID     string
	Title  string
	Target *url.URL
}

// Info is the public shape GET /api/providers returns. The target URL is
// deliberately left out: the browser never talks to it directly.
type Info struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

var (
	envIDRe = regexp.MustCompile(`^[A-Z0-9_]+$`)
	// A Docker service/container name: one DNS label, underscores allowed
	// since Docker's embedded DNS resolves them.
	singleLabelRe = regexp.MustCompile(`^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?$`)
)

// Parse reads every WEBMANAGER_PROVIDER_* entry out of environ. A malformed
// entry is skipped with a log line, never silently: a tab that just doesn't
// appear is otherwise indistinguishable from an overlay that was never
// included.
func Parse(environ []string) []Provider {
	var out []Provider
	for _, kv := range environ {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || !strings.HasPrefix(key, EnvPrefix) {
			continue
		}
		suffix := strings.TrimPrefix(key, EnvPrefix)
		if !envIDRe.MatchString(suffix) {
			log.Printf("providers: %s - the part after %s must match [A-Z0-9_]+ - skipping", key, EnvPrefix)
			continue
		}
		id := strings.ToLower(strings.ReplaceAll(suffix, "_", "-"))
		// Empty is how one of these is switched off without deleting the
		// line. Not an error, but said out loud.
		if strings.TrimSpace(value) == "" {
			log.Printf("providers: %s is empty - skipping (no %q tab)", key, id)
			continue
		}
		title, rawURL, ok := strings.Cut(value, "|")
		title, rawURL = strings.TrimSpace(title), strings.TrimSpace(rawURL)
		if !ok || title == "" || rawURL == "" {
			log.Printf("providers: %s must look like \"<Title>|<URL>\", got %q - skipping", key, value)
			continue
		}
		target, err := ValidateTarget(rawURL)
		if err != nil {
			log.Printf("providers: %s url %q rejected: %v - skipping", key, rawURL, err)
			continue
		}
		out = append(out, Provider{ID: id, Title: title, Target: target})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ValidateTarget accepts only http(s) URLs whose host is a single-label name
// (a container/service name on code-docker-internal) or an IP literal. The
// point is that webmanager can never be configured into a proxy to an
// arbitrary internet site: a dotted name is refused even if it would resolve.
func ValidateTarget(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("only http:// and https:// are allowed")
	}
	if u.User != nil {
		return nil, errors.New("credentials in the URL are not supported")
	}
	host := u.Hostname()
	if host == "" {
		return nil, errors.New("no host")
	}
	if net.ParseIP(host) == nil && !singleLabelRe.MatchString(host) {
		return nil, errors.New("host must be a single-label name (a container on code-docker-internal) or an IP")
	}
	return u, nil
}

var (
	envOnce sync.Once
	fromEnv *Registry
)

// FromEnv parses os.Environ() once. Env does not change under a running
// process, and re-parsing per request would re-log every malformed entry.
func FromEnv() *Registry {
	envOnce.Do(func() { fromEnv = New(Parse(os.Environ())) })
	return fromEnv
}

// Registry serves the parsed providers: the list for the frontend, and the
// reverse proxy for /providers/<id>/....
type Registry struct {
	list    []Provider
	proxies map[string]http.Handler
}

// New builds one reverse proxy per provider.
func New(list []Provider) *Registry {
	r := &Registry{list: list, proxies: make(map[string]http.Handler, len(list))}
	// Cloned with Proxy unset: these targets are names on the internal
	// network, and an HTTP(S)_PROXY in the container's env must never
	// route them through an outbound proxy instead.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	for _, p := range list {
		r.proxies[p.ID] = newProxy(p, transport)
	}
	return r
}

// List returns every provider as {id, title}, never nil - a JSON null here
// would crash the frontend's .map().
func (r *Registry) List() []Info {
	out := []Info{}
	for _, p := range r.list {
		out = append(out, Info{ID: p.ID, Title: p.Title})
	}
	return out
}

// ServeHTTP handles /providers/<id> and everything under it. An unknown id
// is a 404. The bare /providers/<id> redirects to the trailing-slash form
// relatively, because the provider page resolves its relative URLs (api/...)
// against it, and an absolute redirect would drop the /manager prefix the
// browser sees.
func (r *Registry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	rest := strings.TrimPrefix(req.URL.Path, URLPrefix)
	id, _, hasSlash := strings.Cut(rest, "/")
	proxy, ok := r.proxies[id]
	if !ok {
		http.NotFound(w, req)
		return
	}
	if !hasSlash {
		loc := id + "/"
		if req.URL.RawQuery != "" {
			loc += "?" + req.URL.RawQuery
		}
		w.Header().Set("Location", loc)
		w.WriteHeader(http.StatusMovedPermanently)
		return
	}
	proxy.ServeHTTP(w, req)
}

func newProxy(p Provider, transport http.RoundTripper) http.Handler {
	mount := URLPrefix + p.ID
	browserPrefix := BrowserBase + mount + "/"
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			// The id is [a-z0-9-] only, so its escaped form is itself and
			// the same prefix strips both Path and RawPath.
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, mount)
			if pr.In.URL.RawPath != "" {
				pr.Out.URL.RawPath = strings.TrimPrefix(pr.In.URL.RawPath, mount)
			}
			pr.SetURL(p.Target)
			// Everything cookie- or credential-shaped on this origin
			// belongs to webmanager (the unlock cookie) or to whatever
			// fronts it (forward-auth), never to the provider.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Proxy-Authorization")
			pr.Out.Header.Del("X-Real-IP")
			pr.Out.Header.Set("X-Forwarded-Prefix", browserPrefix)
			pr.Out.Header.Set("X-Forwarded-Host", pr.In.Host)
			pr.Out.Header.Set("X-Forwarded-For", authgate.ClientKey(pr.In))
		},
		// A provider shares webmanager's origin, so a cookie it set would
		// land on every /manager/ path - including one named like the
		// unlock cookie. Providers get no cookies at all, in either
		// direction.
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Set-Cookie")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
				return
			}
			log.Printf("providers: %s -> %s: %v", p.ID, p.Target, err)
			http.Error(w, "provider "+p.ID+" is unreachable", http.StatusBadGateway)
		},
	}
}
