// Package netgate manages the live, web-editable copy of netgate's
// outbound CIDR allow/block list and inbound port-forward table -
// previously config.default.yaml/config.override.yaml only, hand-edited
// with a full container recreate required (see root CLAUDE.md's "netgate
// (egress lockdown)" section and router/config/netgate/firewall.default.sh's
// own NETGATE_CONFIG selection). These two features are deliberately one
// package/one API surface, not split like tailscale forwards vs publish -
// a forward's target is itself usually an RFC1918 address, so its FORWARD
// ACCEPT rule and the outbound: block list interact directly (see
// config.default.yaml's own comment on ordering) and were always meant to
// be reviewed together.
//
// EnsureSeeded migrates an existing config.override.yaml (or, failing
// that, the image's own config.default.yaml) into LiveConfigPath exactly
// once - firewall.default.sh calls it before its first apply_rules cycle,
// same "seed once, then only the live copy matters" idiom
// internal/dns.reconcile.go's builtin blocklist source uses, minus the
// hash-tracked update-available bookkeeping (root CLAUDE.md's
// "DNS management" section explicitly deferred giving netgate that same
// parity until this live-copy model existed at all - this package is that
// prerequisite, not the hash-tracking layer itself; add it later if
// diverge-detection turns out to matter here too).
package netgate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"gopkg.in/yaml.v3"

	"router/internal/atomicfile"
)

// mu serializes every read-modify-write below - without it, two concurrent
// requests touching the same file (e.g. two browser tabs) can both read the
// same pre-mutation content and the second writer's save() silently
// discards the first writer's change.
var mu sync.Mutex

// hostRe restricts Forward.TargetHost to a plain hostname/IPv4 literal.
// firewall.default.sh resolves it via `getent` before ever reaching
// iptables, so a malformed value mostly just fails to resolve (low risk on
// its own) - this is defense-in-depth plus a clean 400 at write time
// instead of a silent per-cycle "does not resolve yet, skipping" log line.
var hostRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)

func validateHost(field, host string) error {
	if host == "" || !hostRe.MatchString(host) {
		return fmt.Errorf("%w: %s must be a plain hostname or IPv4 address", ErrValidation, field)
	}
	return nil
}

func validatePort(field string, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("%w: %s must be between 1 and 65535", ErrValidation, field)
	}
	return nil
}

const (
	// LiveConfigPath is what router-manager's own CRUD reads/writes, and
	// what firewall.default.sh polls every cycle once seeded.
	LiveConfigPath = "/var/lib/code-docker-router/netgate/config.yaml"
	// DefaultConfigPath/OverrideConfigPath mirror the image-shipped files
	// firewall.default.sh used to read directly (see root CLAUDE.md's
	// override pattern) - only consulted by EnsureSeeded now.
	DefaultConfigPath  = "/etc/router/netgate/config.default.yaml"
	OverrideConfigPath = "/etc/router/netgate/config.override.yaml"
)

// OutboundRule is one ordered FORWARD-chain entry - see
// config.default.yaml's own comment on why order matters (first-match-wins,
// a narrow allow exception must precede the broad block it carves out of).
type OutboundRule struct {
	Action string `yaml:"action" json:"action"`
	CIDR   string `yaml:"cidr" json:"cidr"`
}

// Forward is one inbound host-port DNAT entry. HostPort is the unique key
// (iptables can only DNAT a given host port to one place at a time, so a
// second entry for the same HostPort is a real conflict, not just a UI
// nicety).
type Forward struct {
	HostPort   int    `yaml:"host_port" json:"hostPort"`
	TargetHost string `yaml:"target_host" json:"targetHost"`
	TargetPort int    `yaml:"target_port" json:"targetPort"`
}

// ServiceLimit is one hard per-container bandwidth cap - TargetHost is
// resolved via `getent` the same way Forward.TargetHost is (see
// shaping.default.sh), so this reuses the same hostname/IPv4 validation.
type ServiceLimit struct {
	TargetHost string `yaml:"target_host" json:"targetHost"`
	LimitMbps  int    `yaml:"limit_mbps" json:"limitMbps"`
}

// Bandwidth is netgate's tc-based egress shaping config, read by
// shaping.default.sh every reapply cycle (same 30s poll idiom
// firewall.default.sh uses for Outbound/Forwards). TotalMbps is a hard cap
// on everything this router forwards *and* originates on the default
// interface (0 = unlimited); each ServiceLimit is an independent hard cap
// on one container's own share, not a share of TotalMbps - see
// shaping.default.sh's own comment on why rate==ceil for both.
type Bandwidth struct {
	TotalMbps int            `yaml:"total_mbps" json:"totalMbps"`
	Services  []ServiceLimit `yaml:"services" json:"services"`
}

type fileConfig struct {
	Outbound  []OutboundRule `yaml:"outbound"`
	Forwards  []Forward      `yaml:"forwards"`
	Bandwidth Bandwidth      `yaml:"bandwidth"`
}

var (
	ErrInvalidAction   = errors.New("action must be allow or block")
	ErrForwardExists   = errors.New("a forward for this host_port already exists")
	ErrForwardNotFound = errors.New("forward not found")
	// ErrValidation wraps every plain input-validation rejection below
	// (validateHost, validatePort, "cidr is required") so handlers can
	// distinguish "the request was malformed" (400) from an I/O failure
	// in load()/save() (500) - previously both fell through to the same
	// default 400, misreporting a real server-side problem as bad input.
	// See root CLAUDE.md's code-quality audit.
	ErrValidation = errors.New("invalid input")
)

func load(path string) (fileConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fileConfig{}, nil
		}
		return fileConfig{}, err
	}
	var cfg fileConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return fileConfig{}, err
	}
	return cfg, nil
}

func save(path string, cfg fileConfig) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0o644, 0o755)
}

// EnsureSeeded copies OverrideConfigPath (if present) or DefaultConfigPath
// into LiveConfigPath, but only when LiveConfigPath doesn't exist yet -
// once router-manager (or a human) has written a live copy, this never
// touches it again, so an image update's changed config.default.yaml can't
// silently clobber a running deployment's customized rules.
func EnsureSeeded() error {
	if _, err := os.Stat(LiveConfigPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	src := DefaultConfigPath
	if _, err := os.Stat(OverrideConfigPath); err == nil {
		src = OverrideConfigPath
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(LiveConfigPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(LiveConfigPath, data, 0o644)
}

func ListOutbound(path string) ([]OutboundRule, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	if cfg.Outbound == nil {
		return []OutboundRule{}, nil
	}
	return cfg.Outbound, nil
}

// ReplaceOutbound overwrites the whole ordered outbound list in one call -
// order is the entire point of this list (see OutboundRule's doc comment),
// so index-based add/delete/reorder endpoints would just be a clunkier way
// to express the same "here's the new order" operation the frontend's
// reorder UI already produces in one shot. Same whole-list-replace idiom
// GET/PUT /api/dns/custom-hosts already uses.
func ReplaceOutbound(path string, rules []OutboundRule) ([]OutboundRule, error) {
	for _, r := range rules {
		if r.Action != "allow" && r.Action != "block" {
			return nil, ErrInvalidAction
		}
		if r.CIDR == "" {
			return nil, fmt.Errorf("%w: cidr is required", ErrValidation)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	cfg.Outbound = rules
	if err := save(path, cfg); err != nil {
		return nil, err
	}
	if cfg.Outbound == nil {
		return []OutboundRule{}, nil
	}
	return cfg.Outbound, nil
}

func ListForwards(path string) ([]Forward, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	if cfg.Forwards == nil {
		return []Forward{}, nil
	}
	return cfg.Forwards, nil
}

func AddForward(path string, f Forward) (Forward, error) {
	if err := validatePort("hostPort", f.HostPort); err != nil {
		return Forward{}, err
	}
	if err := validateHost("targetHost", f.TargetHost); err != nil {
		return Forward{}, err
	}
	if err := validatePort("targetPort", f.TargetPort); err != nil {
		return Forward{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Forward{}, err
	}
	for _, e := range cfg.Forwards {
		if e.HostPort == f.HostPort {
			return Forward{}, ErrForwardExists
		}
	}
	cfg.Forwards = append(cfg.Forwards, f)
	if err := save(path, cfg); err != nil {
		return Forward{}, err
	}
	return f, nil
}

func GetBandwidth(path string) (Bandwidth, error) {
	cfg, err := load(path)
	if err != nil {
		return Bandwidth{}, err
	}
	if cfg.Bandwidth.Services == nil {
		cfg.Bandwidth.Services = []ServiceLimit{}
	}
	return cfg.Bandwidth, nil
}

// SetBandwidth overwrites the whole bandwidth document in one call - same
// whole-document-replace idiom ReplaceOutbound uses, since TotalMbps and
// Services are reviewed together in the UI (a service limit only means
// anything relative to the shared total cap it sits under).
func SetBandwidth(path string, bw Bandwidth) (Bandwidth, error) {
	if bw.TotalMbps < 0 {
		return Bandwidth{}, fmt.Errorf("%w: total_mbps must be 0 or greater", ErrValidation)
	}
	seen := make(map[string]bool, len(bw.Services))
	for _, s := range bw.Services {
		if err := validateHost("targetHost", s.TargetHost); err != nil {
			return Bandwidth{}, err
		}
		if s.LimitMbps < 1 {
			return Bandwidth{}, fmt.Errorf("%w: limit_mbps must be at least 1", ErrValidation)
		}
		if seen[s.TargetHost] {
			return Bandwidth{}, fmt.Errorf("%w: duplicate target_host %s", ErrValidation, s.TargetHost)
		}
		seen[s.TargetHost] = true
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Bandwidth{}, err
	}
	cfg.Bandwidth = bw
	if err := save(path, cfg); err != nil {
		return Bandwidth{}, err
	}
	if cfg.Bandwidth.Services == nil {
		cfg.Bandwidth.Services = []ServiceLimit{}
	}
	return cfg.Bandwidth, nil
}

func DeleteForward(path string, hostPort int) error {
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return err
	}
	found := false
	kept := make([]Forward, 0, len(cfg.Forwards))
	for _, e := range cfg.Forwards {
		if e.HostPort == hostPort {
			found = true
			continue
		}
		kept = append(kept, e)
	}
	if !found {
		return ErrForwardNotFound
	}
	cfg.Forwards = kept
	return save(path, cfg)
}
