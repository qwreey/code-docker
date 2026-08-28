package manifestpatch

import (
	"log"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// EnvPrefix is scanned once at startup for extra jump-list entries. One env
// var per entry rather than one delimited list, because these are normally
// declared by a side project's own compose overlay (`environment:` merged
// onto the code-docker service) — two projects attached at once must not
// have to merge into a single shared value. Same reasoning as router's own
// ROUTER_VHOST_* and as netinit's move from one shared env list to
// per-network Docker labels.
//
// Value format: "<name>|<url>[|<description>]".
const EnvPrefix = "WEBMANAGER_MANIFEST_SHORTCUT_"

// GotoPrefix is the URL path that stands in for an off-origin target. A
// manifest shortcut's url must be within the manifest's scope or the browser
// drops that entry — silently, with no console error and nothing in
// DevTools' manifest view beyond the entry simply not being there (W3C
// appmanifest, "process the shortcuts member": an out-of-scope url fails
// that one item, not the manifest). So an absolute URL pointing at another
// origin — which is the normal case here, since the whole reason a side app
// gets its own hostname is to not share code-server's origin — can never be
// a shortcut url directly. It is published as this same-origin path instead,
// which redirects. The scope check reads the url as written; where it ends
// up afterwards is not its business.
const GotoPrefix = "/goto/"

// Shortcut is one parsed WEBMANAGER_MANIFEST_SHORTCUT_* entry.
type Shortcut struct {
	// ID comes from the env var's own suffix, lowercased with underscores
	// turned into dashes — so it is stable, unique by construction (two
	// entries cannot share an env var name), and needs no separate field.
	ID string
	// Name is what the OS shows in the jump list.
	Name string
	// Description is optional; exposed to assistive tech, not drawn.
	Description string
	// Target is the URL as configured — where /goto/<id> redirects to.
	Target string
	// OffOrigin is true when Target is an absolute URL, i.e. when the
	// manifest must advertise /goto/<id> instead of Target itself.
	OffOrigin bool
}

// ManifestURL is what belongs in the manifest's shortcuts[].url for this
// entry: the target itself when it is already a same-origin path, the
// redirect stub otherwise.
func (s Shortcut) ManifestURL() string {
	if s.OffOrigin {
		return GotoPrefix + s.ID
	}
	return s.Target
}

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

var (
	extraOnce sync.Once
	extra     []Shortcut
)

// Extra returns the parsed WEBMANAGER_MANIFEST_SHORTCUT_* entries, sorted by
// ID so the jump list has a stable order across restarts. Parsed once — env
// does not change under a running process, and re-scanning per manifest
// request would re-log every malformed entry on every fetch.
func Extra() []Shortcut {
	extraOnce.Do(func() { extra = parseEnv(os.Environ()) })
	return extra
}

// Lookup finds a parsed entry by ID, for the /goto/<id> handler.
func Lookup(id string) (Shortcut, bool) {
	for _, s := range Extra() {
		if s.ID == id {
			return s, true
		}
	}
	return Shortcut{}, false
}

// parseEnv is the testable half of Extra. A malformed entry is skipped and
// said out loud: a shortcut that silently never appears is indistinguishable
// from one the browser dropped for its own reasons, and that is exactly the
// failure this whole mechanism exists to route around.
func parseEnv(environ []string) []Shortcut {
	var out []Shortcut
	for _, kv := range environ {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || !strings.HasPrefix(key, EnvPrefix) {
			continue
		}
		id := strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(key, EnvPrefix), "_", "-"))
		if !idRe.MatchString(id) {
			log.Printf("manifestpatch: %s has no usable id in its name (got %q) - skipping", key, id)
			continue
		}
		// Empty is how one of these is switched off without deleting the
		// line, the same convention OOTB_GENERATE_SECRETS keys use. Not an
		// error, but not silent either.
		if strings.TrimSpace(value) == "" {
			log.Printf("manifestpatch: %s is empty - skipping (no %q jump-list entry)", key, id)
			continue
		}
		parts := strings.Split(value, "|")
		if len(parts) < 2 {
			log.Printf("manifestpatch: %s must look like \"<name>|<url>[|<description>]\", got %q - skipping", key, value)
			continue
		}
		name := strings.TrimSpace(parts[0])
		target := strings.TrimSpace(parts[1])
		desc := ""
		if len(parts) > 2 {
			desc = strings.TrimSpace(strings.Join(parts[2:], "|"))
		}
		if name == "" || target == "" {
			log.Printf("manifestpatch: %s needs both a name and a url, got %q - skipping", key, value)
			continue
		}
		offOrigin, err := classifyTarget(target)
		if err != nil {
			log.Printf("manifestpatch: %s url %q is not usable: %v - skipping", key, target, err)
			continue
		}
		out = append(out, Shortcut{ID: id, Name: name, Description: desc, Target: target, OffOrigin: offOrigin})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// classifyTarget reports whether target has to go through the /goto stub,
// and rejects anything that is neither a same-origin path nor an ordinary
// http(s) URL. The scheme allowlist is the point: /goto redirects to
// whatever this returns, so a javascript: or data: value here would be a
// redirect into script.
func classifyTarget(target string) (offOrigin bool, err error) {
	if strings.HasPrefix(target, "/") {
		// "//host/path" is protocol-relative — a different origin wearing a
		// path's clothing. Treat it as the off-origin URL it is rather than
		// letting it into the manifest as if it were local.
		if strings.HasPrefix(target, "//") {
			return true, nil
		}
		return false, nil
	}
	u, err := url.Parse(target)
	if err != nil {
		return false, err
	}
	switch u.Scheme {
	case "http", "https":
		if u.Host == "" {
			return false, errNoHost
		}
		return true, nil
	default:
		return false, errScheme
	}
}

var (
	errScheme = errorString("only http:// and https:// URLs, or a same-origin path starting with /")
	errNoHost = errorString("absolute URL with no host")
)

type errorString string

func (e errorString) Error() string { return string(e) }
