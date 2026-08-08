package dns

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ResolverConfigPath drives dns.default.sh's upstream resolver choice - see
// dnsmasq.default.conf's own resolv-file= comment for why "auto" (the
// default) exists at all: reading this container's own /etc/resolv.conf
// (Docker-filled from the host) needs no configuration and works for most
// setups. "custom" opts into a fixed, user-chosen upstream (e.g. 1.1.1.1)
// instead - purely a dnsmasq no-resolv+server= flag combination, no new
// mechanism needed, confirmed feasible in userspace.
const ResolverConfigPath = "/var/lib/code-docker-router/dns/config.yaml"

// ResolverConfig is GET/PUT /api/dns/resolver's body.
type ResolverConfig struct {
	Mode    string   `yaml:"mode" json:"mode"` // "auto" | "custom"
	Servers []string `yaml:"servers" json:"servers"`
}

type resolverFile struct {
	Resolver ResolverConfig `yaml:"resolver"`
}

var ErrInvalidResolverMode = errors.New(`mode must be "auto" or "custom"`)

// GetResolverConfig defaults to {mode: "auto", servers: []} when the file
// doesn't exist yet - matches dns.default.sh's own fallback so a missing
// config file and an explicit auto-mode config behave identically.
func GetResolverConfig() (ResolverConfig, error) {
	data, err := os.ReadFile(ResolverConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ResolverConfig{Mode: "auto", Servers: []string{}}, nil
		}
		return ResolverConfig{}, err
	}
	var f resolverFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return ResolverConfig{}, err
	}
	if f.Resolver.Mode == "" {
		f.Resolver.Mode = "auto"
	}
	if f.Resolver.Servers == nil {
		f.Resolver.Servers = []string{}
	}
	return f.Resolver, nil
}

func SetResolverConfig(cfg ResolverConfig) error {
	if cfg.Mode != "auto" && cfg.Mode != "custom" {
		return ErrInvalidResolverMode
	}
	if cfg.Mode == "custom" {
		if len(cfg.Servers) == 0 {
			return errors.New("at least one server is required in custom mode")
		}
		for _, s := range cfg.Servers {
			if net.ParseIP(s) == nil {
				return fmt.Errorf("invalid server address: %q", s)
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(ResolverConfigPath), 0o755); err != nil {
		return err
	}
	data, err := yaml.Marshal(resolverFile{Resolver: cfg})
	if err != nil {
		return err
	}
	return os.WriteFile(ResolverConfigPath, data, 0o644)
}
