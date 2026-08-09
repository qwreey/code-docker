package dns

import (
	"fmt"
	"net"
	"os"
	"strings"

	"gopkg.in/yaml.v3"

	"router/internal/atomicfile"
)

const (
	// CustomHostsConfigPath is the structured store (round-trips cleanly
	// for editing); CustomHostsRenderedPath is the hosts-format file
	// dns.default.sh actually feeds dnsmasq via --addn-hosts=. Same
	// split ConfigPath/generated-file split router/internal/tailscale's
	// config.yaml and internal/devproxy's managed *.caddy fragments both
	// use for their own reasons.
	CustomHostsConfigPath   = "/var/lib/code-docker-router/dns/custom-hosts.yaml"
	CustomHostsRenderedPath = "/var/lib/code-docker-router/dns/custom-hosts.hosts"
)

// HostEntry is a MagicDNS-style custom hostname->IP mapping - unlike a
// blocklist entry (always 0.0.0.0), Ip is a real address the user supplies.
type HostEntry struct {
	Host string `yaml:"host" json:"host"`
	IP   string `yaml:"ip" json:"ip"`
}

type customHostsFile struct {
	Entries []HostEntry `yaml:"entries"`
}

// ValidateHostEntry checks e's fields are safe to splice into a hosts-format
// line: Host is a plain hostname (see ValidateHostname), Ip parses as an IP.
func ValidateHostEntry(e HostEntry) error {
	if err := ValidateHostname(e.Host); err != nil {
		return err
	}
	if net.ParseIP(e.IP) == nil {
		return fmt.Errorf("invalid IP address: %q", e.IP)
	}
	return nil
}

// ListCustomHosts returns the current entries, empty (not an error) if the
// config has never been written.
func ListCustomHosts() ([]HostEntry, error) {
	data, err := os.ReadFile(CustomHostsConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []HostEntry{}, nil
		}
		return nil, err
	}
	var f customHostsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.Entries == nil {
		return []HostEntry{}, nil
	}
	return f.Entries, nil
}

// SetCustomHosts replaces the whole list - a full-replace API rather than
// per-entry CRUD, since this is expected to stay small (a handful of
// manually-curated hostnames), same reasoning tailscale.SetGlobalConfig
// applies to its own few fields. Re-renders CustomHostsRenderedPath so the
// change takes effect on the caller's subsequent `dns` program restart.
func SetCustomHosts(entries []HostEntry) error {
	seen := make(map[string]bool, len(entries))
	for _, e := range entries {
		if err := ValidateHostEntry(e); err != nil {
			return err
		}
		if seen[e.Host] {
			return fmt.Errorf("duplicate host: %q", e.Host)
		}
		seen[e.Host] = true
	}

	data, err := yaml.Marshal(customHostsFile{Entries: entries})
	if err != nil {
		return err
	}

	mu.Lock()
	defer mu.Unlock()
	if err := atomicfile.Write(CustomHostsConfigPath, data, 0o644, 0o755); err != nil {
		return err
	}

	if len(entries) == 0 {
		// dns.default.sh only passes --addn-hosts= for this file if it
		// exists - remove it so an emptied list doesn't linger as a
		// zero-byte extra arg forever. Harmless either way, just tidier.
		if err := os.Remove(CustomHostsRenderedPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}

	var b strings.Builder
	for _, e := range entries {
		b.WriteString(e.IP)
		b.WriteByte(' ')
		b.WriteString(e.Host)
		b.WriteByte('\n')
	}
	return atomicfile.Write(CustomHostsRenderedPath, []byte(b.String()), 0o644, 0o755)
}
