package dns

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"router/internal/atomicfile"
)

// mu serializes every read-modify-write in this package (blocklist sources,
// the shared manifest, custom-hosts, and the resolver config all live under
// `package dns`) - without it, two concurrent requests touching the same
// file can each read stale content and the second writer's save silently
// discards the first's change. Most consequential for the manifest
// (LoadManifest/SaveManifest in reconcile.go): CreateSource/BuiltinPull/
// BuiltinIgnore all read-modify-write it independently.
var mu sync.Mutex

const (
	// SourcesDir holds one hosts-format file per blocklist source - dns.
	// default.sh globs every file here into its own `--addn-hosts=` flag
	// (dnsmasq happily accepts the flag repeated; this is just the existing
	// blocklist.override.hosts trick generalized to N files instead of 1).
	SourcesDir = "/var/lib/code-docker-router/dns/blocklist-sources"

	// BuiltinName is reserved - it's the one hash-tracked source, seeded
	// from the image's own blocklist.default.hosts (see ShippedDefaultPath
	// below - deliberately NOT blocklist.override.hosts, which stays its
	// own always-additive, unconditional --addn-hosts= flag in
	// dns.default.sh, same as before this package existed - see that
	// script's own comment on why folding it in here would have quietly
	// changed its documented semantics), and can't be edited or deleted
	// through the custom-source CRUD below (see ErrBuiltinImmutable).
	BuiltinName = "builtin"

	// shippedDefaultPathDefault is what ShippedDefaultPath() falls back to
	// when DNS_BUILTIN_BLOCKLIST_SOURCE is unset - the image-shipped
	// default. dns.default.sh's own seed_builtin_blocklist reads the exact
	// same env var with the same fallback, so this stays in sync with
	// whatever a deployment actually seeded from - see
	// example-env.router's own comment on DNS_BUILTIN_BLOCKLIST_SOURCE for
	// why this is env-driven (deploy-time bind-mount override) rather than
	// a plain constant.
	shippedDefaultPathDefault = "/etc/code-docker/dns/blocklist.default.hosts"
)

// ShippedDefaultPath is read by both the seed step in dns.default.sh and
// this package's own GetBuiltinStatus - keep them in sync if either ever
// changes how it resolves this.
func ShippedDefaultPath() string {
	if v := os.Getenv("DNS_BUILTIN_BLOCKLIST_SOURCE"); v != "" {
		return v
	}
	return shippedDefaultPathDefault
}

// BuiltinPath is where the builtin source's live copy lives.
func BuiltinPath() string { return filepath.Join(SourcesDir, BuiltinName+".hosts") }

func customPath(name string) string { return filepath.Join(SourcesDir, name+".hosts") }

var (
	ErrSourceNotFound   = errors.New("blocklist source not found")
	ErrSourceExists     = errors.New("blocklist source already exists")
	ErrBuiltinImmutable = errors.New("the builtin source can't be edited or deleted directly - use its pull/ignore actions instead")
)

var sourceNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// ValidateSourceName checks name is a safe filename component (same
// RFC1123-label charset devproxy.ValidateName uses) and not the reserved
// builtin name.
func ValidateSourceName(name string) error {
	if name == BuiltinName {
		return ErrBuiltinImmutable
	}
	if !sourceNameRe.MatchString(name) {
		return errors.New("name must be a lowercase label (alphanumeric/hyphen, no leading/trailing hyphen)")
	}
	return nil
}

var hostnameRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)

// ValidateHostname checks h is a plausible plain hostname - no wildcards
// (unlike devproxy.ValidateHost): dnsmasq's addn-hosts is a literal /etc/
// hosts-style lookup table, not a pattern matcher, so a "*.example.com"
// entry here would just never match anything.
func ValidateHostname(h string) error {
	if h == "" || !hostnameRe.MatchString(h) {
		return fmt.Errorf("invalid hostname: %q", h)
	}
	return nil
}

func renderHostsFile(hosts []string) string {
	var b strings.Builder
	for _, h := range hosts {
		b.WriteString("0.0.0.0 ")
		b.WriteString(h)
		b.WriteByte('\n')
	}
	return b.String()
}

// parseHostsList recovers the plain hostname list from a rendered hosts
// file - the inverse of renderHostsFile. Tolerant of any leading address
// column (used for both blocklist sources, always "0.0.0.0", and to sanity-
// check the builtin file which real-world hosts lists format the same way).
func parseHostsList(content string) []string {
	var hosts []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		hosts = append(hosts, fields[1])
	}
	return hosts
}

func dedupe(hosts []string) []string {
	seen := make(map[string]bool, len(hosts))
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		if seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	return out
}

// SourceInfo is one entry in List's response. Hosts is only populated for
// custom sources - the builtin source can be a StevenBlack-sized list
// (hundreds of thousands of lines), so shipping its full content on every
// list load would be wasteful; EntryCount is enough for display, and
// BuiltinStatus's AddedSample/RemovedSample cover the "what actually
// changed" question when an update is pending.
type SourceInfo struct {
	Name       string   `json:"name"`
	Builtin    bool     `json:"builtin"`
	EntryCount int      `json:"entryCount"`
	Hosts      []string `json:"hosts,omitempty"`
}

// ListResult is GET /api/dns/blocklist-sources's body.
type ListResult struct {
	Sources                []SourceInfo `json:"sources"`
	DuplicateHosts         []string     `json:"duplicateHosts"`
	BuiltinUpdateAvailable bool         `json:"builtinUpdateAvailable"`
}

// List enumerates every source under SourcesDir. extraHosts is the current
// custom-hosts entry list (see customhosts.go) - included only for
// DuplicateHosts detection, since a hostname mapped to a real IP there and
// also blocked here is a genuine, silently-ambiguous conflict from
// dnsmasq's point of view (see the plan doc's "블록리스트와 추가 호스트가
// 같은 호스트 이름을 가리키면?"). It never appears in Sources.
func List(extraHosts []string) (ListResult, error) {
	entries, err := os.ReadDir(SourcesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return ListResult{Sources: []SourceInfo{}, DuplicateHosts: []string{}}, nil
		}
		return ListResult{}, err
	}

	owners := map[string][]string{}
	for _, h := range extraHosts {
		owners[h] = append(owners[h], "custom-hosts")
	}

	// sources/duplicates start as empty (not nil) slices - a nil slice
	// marshals to JSON `null`, and the frontend calls .length on both
	// unconditionally (no data yet is a genuinely empty list, not an
	// absent one).
	sources := []SourceInfo{}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".hosts") {
			continue
		}
		name := strings.TrimSuffix(ent.Name(), ".hosts")
		data, err := os.ReadFile(filepath.Join(SourcesDir, ent.Name()))
		if err != nil {
			continue
		}
		hosts := parseHostsList(string(data))
		for _, h := range hosts {
			owners[h] = append(owners[h], name)
		}
		info := SourceInfo{Name: name, Builtin: name == BuiltinName, EntryCount: len(hosts)}
		if !info.Builtin {
			info.Hosts = hosts
		}
		sources = append(sources, info)
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].Builtin != sources[j].Builtin {
			return sources[i].Builtin
		}
		return sources[i].Name < sources[j].Name
	})

	// len(names) alone would over-count: the same hostname commonly repeats
	// *within* one source (e.g. builtin's own multi-hundred-thousand-line
	// list), which isn't a conflict at all - dedupe to the distinct set of
	// owning source names first.
	duplicates := []string{}
	for h, names := range owners {
		if len(dedupe(names)) > 1 {
			duplicates = append(duplicates, h)
		}
	}
	sort.Strings(duplicates)

	status, statusErr := GetBuiltinStatus()
	updateAvailable := statusErr == nil && status.UpdateAvailable

	return ListResult{
		Sources:                sources,
		DuplicateHosts:         duplicates,
		BuiltinUpdateAvailable: updateAvailable,
	}, nil
}

// CreateSource adds a new custom (non-builtin) source.
func CreateSource(name string, hosts []string) error {
	if err := ValidateSourceName(name); err != nil {
		return err
	}
	for _, h := range hosts {
		if err := ValidateHostname(h); err != nil {
			return err
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if _, err := os.Stat(customPath(name)); err == nil {
		return ErrSourceExists
	}
	return atomicfile.Write(customPath(name), []byte(renderHostsFile(dedupe(hosts))), 0o644, 0o755)
}

// UpdateSource overwrites an existing custom source's host list.
func UpdateSource(name string, hosts []string) error {
	if err := ValidateSourceName(name); err != nil {
		return err
	}
	for _, h := range hosts {
		if err := ValidateHostname(h); err != nil {
			return err
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if _, err := os.Stat(customPath(name)); err != nil {
		return ErrSourceNotFound
	}
	return atomicfile.Write(customPath(name), []byte(renderHostsFile(dedupe(hosts))), 0o644, 0o755)
}

// DeleteSource removes a custom source.
func DeleteSource(name string) error {
	if name == BuiltinName {
		return ErrBuiltinImmutable
	}
	mu.Lock()
	defer mu.Unlock()
	p := customPath(name)
	if _, err := os.Stat(p); err != nil {
		return ErrSourceNotFound
	}
	return os.Remove(p)
}

// BuiltinStatus is GET /api/dns/blocklist-sources/builtin/status's body -
// see the plan doc's three-hash reconcile algorithm. UpdateAvailable means
// the image's shipped blocklist.default.hosts/.override.hosts has changed
// since this source was last seeded/acknowledged; LiveDiverged (only
// meaningful when UpdateAvailable is true) means the live copy no longer
// matches what was last seeded, i.e. dns.default.sh's own boot-time seed
// step already found it unsafe to silently re-apply and left it alone -
// this is the "ask the user" case Pull/Ignore exist for.
type BuiltinStatus struct {
	UpdateAvailable bool     `json:"updateAvailable"`
	LiveDiverged    bool     `json:"liveDiverged"`
	AddedCount      int      `json:"addedCount"`
	RemovedCount    int      `json:"removedCount"`
	AddedSample     []string `json:"addedSample"`
	RemovedSample   []string `json:"removedSample"`
}

const diffSampleLimit = 50

func diffHostLists(oldHosts, newHosts []string) (added, removed []string) {
	oldSet := make(map[string]bool, len(oldHosts))
	for _, h := range oldHosts {
		oldSet[h] = true
	}
	newSet := make(map[string]bool, len(newHosts))
	for _, h := range newHosts {
		newSet[h] = true
	}
	for h := range newSet {
		if !oldSet[h] {
			added = append(added, h)
		}
	}
	for h := range oldSet {
		if !newSet[h] {
			removed = append(removed, h)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return added, removed
}

// sampleStrings never returns nil - an empty/short input still round-trips
// to JSON `[]`, not `null` (the frontend calls .length on this unconditionally).
func sampleStrings(s []string, n int) []string {
	if s == nil {
		return []string{}
	}
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// GetBuiltinStatus computes BuiltinStatus fresh from disk each call - see
// the plan doc's three-hash algorithm. Cheap enough for an admin panel (one
// sha1 pass over the shipped/live files, plus a host-set diff only when an
// update is actually pending).
func GetBuiltinStatus() (BuiltinStatus, error) {
	// AddedSample/RemovedSample default to empty (not nil) slices - see
	// sampleStrings's own doc comment on why a nil slice here would break
	// the frontend's unconditional .length checks.
	empty := BuiltinStatus{AddedSample: []string{}, RemovedSample: []string{}}

	shipped, err := os.ReadFile(ShippedDefaultPath())
	if err != nil {
		return empty, err
	}
	shippedHash := hashHex(shipped)

	manifest, err := LoadManifest(ManifestPath)
	if err != nil {
		return empty, err
	}
	seededHash := manifest[BuiltinName]

	if seededHash == "" || shippedHash == seededHash {
		return empty, nil
	}

	st := empty
	st.UpdateAvailable = true
	live, err := os.ReadFile(BuiltinPath())
	if err != nil {
		return st, nil
	}
	st.LiveDiverged = hashHex(live) != seededHash
	added, removed := diffHostLists(parseHostsList(string(live)), parseHostsList(string(shipped)))
	st.AddedCount = len(added)
	st.RemovedCount = len(removed)
	st.AddedSample = sampleStrings(added, diffSampleLimit)
	st.RemovedSample = sampleStrings(removed, diffSampleLimit)
	return st, nil
}

// BuiltinPull overwrites the builtin source's live copy with the current
// shipped content and records the new baseline - the explicit "가져오기"
// action for when LiveDiverged is true (the safe/untouched case is already
// handled silently by dns.default.sh's own boot-time seed step, so by the
// time a human sees UpdateAvailable=true here, it's always the diverged
// case).
func BuiltinPull() error {
	mu.Lock()
	defer mu.Unlock()
	shipped, err := os.ReadFile(ShippedDefaultPath())
	if err != nil {
		return err
	}
	if err := atomicfile.Write(BuiltinPath(), shipped, 0o644, 0o755); err != nil {
		return err
	}
	manifest, err := LoadManifest(ManifestPath)
	if err != nil {
		return err
	}
	manifest[BuiltinName] = hashHex(shipped)
	return SaveManifest(ManifestPath, manifest)
}

// BuiltinIgnore acknowledges the new shipped content without touching the
// live copy - the explicit "무시" action: stops the update-available badge
// from reappearing for this same shipped version, but keeps whatever the
// user has customized.
func BuiltinIgnore() error {
	mu.Lock()
	defer mu.Unlock()
	shipped, err := os.ReadFile(ShippedDefaultPath())
	if err != nil {
		return err
	}
	manifest, err := LoadManifest(ManifestPath)
	if err != nil {
		return err
	}
	manifest[BuiltinName] = hashHex(shipped)
	return SaveManifest(ManifestPath, manifest)
}
