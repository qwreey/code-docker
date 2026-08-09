// Package dns manages router's DNS forwarder (dnsmasq) configuration: the
// content blocklist sources, custom hostname->IP entries, and upstream
// resolver override. All three used to be pure default/override files with
// no runtime API at all (see root CLAUDE.md's history) - this package is
// what lets router-manager expose them for web management, same tier as
// internal/tailscale and internal/devproxy.
//
// See router/.claude/dns-blocklist-management-plan.md for the full design.
// The one non-obvious piece: the builtin blocklist source is still seeded
// from an image-shipped default/override file, and this package reuses
// config/code/code-patch.default.sh's own hash-tracking algorithm to decide
// whether a later image update can be silently re-applied (live copy
// untouched since last seed) or needs a human decision (live copy has
// diverged - now possible via this package's own write API, not just manual
// file edits) - see builtinStatus/BuiltinPull/BuiltinIgnore in blocklist.go.
package dns

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"strings"

	"router/internal/atomicfile"
)

// ManifestPath tracks, per hash-tracked builtin source, the shipped-content
// hash its live copy was last synced to. Format is "<name>\t<hash>" per
// line - identical to code-patch's own manifest, deliberately: the seed
// step in dns.default.sh writes this with plain shell (no JSON/YAML parser
// needed), and this package reads/writes the exact same trivial format.
const ManifestPath = "/var/lib/code-docker-router/dns/blocklist-manifest"

func hashHex(content []byte) string {
	sum := sha1.Sum(content)
	return hex.EncodeToString(sum[:])
}

// LoadManifest reads path, if present. A missing file is not an error - it
// just means nothing has been seeded/tracked yet (e.g. dns.default.sh
// hasn't run its bootstrap step for the first time).
func LoadManifest(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	m := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		name, hash, ok := strings.Cut(line, "\t")
		if !ok || name == "" {
			continue
		}
		m[name] = hash
	}
	return m, nil
}

// SaveManifest rewrites path with m's full contents (not an append/patch -
// same "read whole thing, rewrite whole thing" approach every other
// config.go in this codebase uses for its own small YAML files).
func SaveManifest(path string, m map[string]string) error {
	var b strings.Builder
	for name, hash := range m {
		b.WriteString(name)
		b.WriteByte('\t')
		b.WriteString(hash)
		b.WriteByte('\n')
	}
	return atomicfile.Write(path, []byte(b.String()), 0o644, 0o755)
}
