// config.go reads and writes ConfigPath — the forwards/publish config
// consumed by tailscale-forward.default.sh/tailscale-publish.default.sh at
// program start (see router/config/tailscale/*.default.sh's own CONFIG=
// variable, and root CLAUDE.md's "tailscale" section). Ported from
// webmanager/backend/internal/tailscale/config.go (see router/plan.md's TODO
// list) — only ConfigPath's value changed, from webmanager's old
// /code/.local/share/code-docker/tailscale/config.yaml to router's own
// persistent volume. This package doesn't reseed the file if missing — that
// stays the shell scripts' job (same principle internal/devproxy follows for
// the Caddyfile) — and every write helper here only rewrites the fields it
// owns and leaves the rest of the document intact; callers are responsible
// for triggering a tailscale-forward/tailscale-publish supervisord restart
// afterward so the change takes effect (this package does not know about
// supervisord).
package tailscale

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"

	"router/internal/atomicfile"
	"router/internal/targetguard"
)

const ConfigPath = "/var/lib/code-docker-router/tailscale/config.yaml"

// mu serializes every read-modify-write below - see internal/netgate's
// identical mu for why (lost-update prevention across concurrent requests).
var mu sync.Mutex

// hostRe restricts RemoteHost/TargetHost to a plain hostname or IPv4
// literal - no IPv6 literal support, since none of the consuming shell
// scripts have a bracket-notation escape hatch for one. Same charset as
// internal/dns.ValidateHostname (this package intentionally keeps its own
// copy rather than importing an unrelated feature package, matching how
// internal/devproxy also owns its own hostRe).
var hostRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)

// socksAddrRe restricts SocksAddress to host:port - it's spliced as a
// single field between two other colon-separated fields in
// tailscale-forward.default.sh's `SOCKS5:"$socks5":"$remote_host":"$remote_port"`,
// so anything beyond exactly one embedded colon (or a comma, which socat
// parses as an additional address option) would corrupt or extend that
// command line silently instead of just failing to connect.
var socksAddrRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?:[0-9]{1,5}$`)

// validateHost rejects anything outside hostRe - in particular commas and
// colons, which socat (forwards' `SOCKS5:host:port` address) and this
// package's own `tcp://host:port` (publish) parse as extra address
// options/field separators rather than literal hostname characters. An
// unvalidated value here is accepted by the API, persisted, and only
// surfaces as a socat/tailscale-serve misparse after the next restart.
//
// Also rejects targetguard.SelfHosts (router/forward/localhost/127.0.0.1/
// ::1), the same shared self-SSRF block devproxy/approutes already enforce
// on their own targets, no opt-out: a Publish.TargetHost of "127.0.0.1" or
// "router" would `tailscale serve` router's own loopback-bound services
// (e.g. an internal admin port) out to the entire tailnet, and a
// Forward.RemoteHost of the same would have tailscaled's own SOCKS5 proxy
// connect back to router's loopback, exposing it to code-docker-internal
// via the forward's local_port.
func validateHost(field, host string) error {
	if host == "" || !hostRe.MatchString(host) {
		return fmt.Errorf("%w: %s must be a plain hostname or IPv4 address", ErrValidation, field)
	}
	if targetguard.SelfHosts[strings.ToLower(host)] {
		return fmt.Errorf("%w: %s %q would point back at router itself", ErrValidation, field, host)
	}
	return nil
}

func validateSocksAddress(addr string) error {
	if addr == "" || !socksAddrRe.MatchString(addr) {
		return fmt.Errorf("%w: socksAddress must be host:port", ErrValidation)
	}
	return nil
}

// validatePort rejects anything outside the valid TCP port range - a
// negative or >65535 value is currently only checked as "!= 0" by callers,
// so it's persisted and only fails opaquely from socat/tailscale serve
// after the next restart instead of as a clean validation error now.
func validatePort(field string, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("%w: %s must be between 1 and 65535", ErrValidation, field)
	}
	return nil
}

// Forward pulls a remote tailnet peer's port into the container (socat +
// SOCKS5). RetryInterval of 0 means "inherit the global default".
type Forward struct {
	Name          string `yaml:"name" json:"name"`
	LocalPort     int    `yaml:"local_port" json:"localPort"`
	RemoteHost    string `yaml:"remote_host" json:"remoteHost"`
	RemotePort    int    `yaml:"remote_port" json:"remotePort"`
	RetryInterval int    `yaml:"retry_intervall,omitempty" json:"retryInterval"`
}

// Publish exposes a port on some code-docker-internal host to the tailnet
// via `tailscale serve`. TargetHost is any hostname/IP reachable from
// router on code-docker-internal (defaults to "code-docker" when omitted,
// for compatibility with entries written before TargetHost existed — see
// tailscale-publish.default.sh).
type Publish struct {
	Name          string `yaml:"name" json:"name"`
	TailscalePort int    `yaml:"tailscale_port" json:"tailscalePort"`
	TargetHost    string `yaml:"target_host" json:"targetHost"`
	LocalPort     int    `yaml:"local_port" json:"localPort"`
	Mode          string `yaml:"mode" json:"mode"`
}

// GlobalConfig is the top-level, non-list part of the file.
type GlobalConfig struct {
	SocksAddress  string `json:"socksAddress"`
	RetryInterval int    `json:"retryInterval"`
}

// fileConfig mirrors the full YAML document. Round-tripping through this
// drops comments in the original file — an accepted tradeoff once
// router-manager owns this file.
type fileConfig struct {
	SocksAddress  string    `yaml:"socks5_address"`
	RetryInterval int       `yaml:"retry_intervall"`
	Forwards      []Forward `yaml:"forwards"`
	Publish       []Publish `yaml:"publish"`
}

var (
	ErrForwardExists   = errors.New("forward already exists")
	ErrForwardNotFound = errors.New("forward not found")
	ErrPublishExists   = errors.New("publish already exists")
	ErrPublishNotFound = errors.New("publish not found")
	ErrInvalidMode     = errors.New("mode must be tcp or tls-terminated-tcp")
	// ErrValidation wraps every plain input-validation rejection below
	// (validateHost, validatePort, validateSocksAddress, "name is
	// required") so handlers can distinguish "the request was malformed"
	// (400) from an I/O failure in load()/save() (500) - see
	// internal/netgate's identical ErrValidation for the full reasoning.
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

func GetGlobalConfig(path string) (GlobalConfig, error) {
	cfg, err := load(path)
	if err != nil {
		return GlobalConfig{}, err
	}
	return GlobalConfig{SocksAddress: cfg.SocksAddress, RetryInterval: cfg.RetryInterval}, nil
}

func SetGlobalConfig(path string, g GlobalConfig) error {
	if err := validateSocksAddress(g.SocksAddress); err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return err
	}
	cfg.SocksAddress = g.SocksAddress
	cfg.RetryInterval = g.RetryInterval
	return save(path, cfg)
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
	if f.Name == "" {
		return Forward{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	if err := validatePort("localPort", f.LocalPort); err != nil {
		return Forward{}, err
	}
	if err := validateHost("remoteHost", f.RemoteHost); err != nil {
		return Forward{}, err
	}
	if err := validatePort("remotePort", f.RemotePort); err != nil {
		return Forward{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Forward{}, err
	}
	for _, e := range cfg.Forwards {
		if e.Name == f.Name {
			return Forward{}, ErrForwardExists
		}
	}
	cfg.Forwards = append(cfg.Forwards, f)
	if err := save(path, cfg); err != nil {
		return Forward{}, err
	}
	return f, nil
}

// UpdateForward overwrites an existing forward's fields, keyed by its
// current name - renaming isn't supported through this path (the frontend
// disables the name field on edit, same as dns.UpdateSource).
func UpdateForward(path, name string, f Forward) (Forward, error) {
	f.Name = name
	if err := validatePort("localPort", f.LocalPort); err != nil {
		return Forward{}, err
	}
	if err := validateHost("remoteHost", f.RemoteHost); err != nil {
		return Forward{}, err
	}
	if err := validatePort("remotePort", f.RemotePort); err != nil {
		return Forward{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Forward{}, err
	}
	found := false
	for i, e := range cfg.Forwards {
		if e.Name == name {
			cfg.Forwards[i] = f
			found = true
			break
		}
	}
	if !found {
		return Forward{}, ErrForwardNotFound
	}
	if err := save(path, cfg); err != nil {
		return Forward{}, err
	}
	return f, nil
}

func DeleteForward(path, name string) error {
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return err
	}
	found := false
	kept := make([]Forward, 0, len(cfg.Forwards))
	for _, e := range cfg.Forwards {
		if e.Name == name {
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

func ListPublish(path string) ([]Publish, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	if cfg.Publish == nil {
		return []Publish{}, nil
	}
	return cfg.Publish, nil
}

func AddPublish(path string, p Publish) (Publish, error) {
	if p.Mode == "" {
		p.Mode = "tcp"
	}
	if p.Mode != "tcp" && p.Mode != "tls-terminated-tcp" {
		return Publish{}, ErrInvalidMode
	}
	if p.TargetHost == "" {
		p.TargetHost = "code-docker"
	}
	if p.Name == "" {
		return Publish{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	if err := validateHost("targetHost", p.TargetHost); err != nil {
		return Publish{}, err
	}
	if err := validatePort("tailscalePort", p.TailscalePort); err != nil {
		return Publish{}, err
	}
	if err := validatePort("localPort", p.LocalPort); err != nil {
		return Publish{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Publish{}, err
	}
	for _, e := range cfg.Publish {
		if e.Name == p.Name {
			return Publish{}, ErrPublishExists
		}
	}
	cfg.Publish = append(cfg.Publish, p)
	if err := save(path, cfg); err != nil {
		return Publish{}, err
	}
	return p, nil
}

// UpdatePublish overwrites an existing publish's fields, keyed by its
// current name - same rename restriction as UpdateForward.
func UpdatePublish(path, name string, p Publish) (Publish, error) {
	p.Name = name
	if p.Mode == "" {
		p.Mode = "tcp"
	}
	if p.Mode != "tcp" && p.Mode != "tls-terminated-tcp" {
		return Publish{}, ErrInvalidMode
	}
	if p.TargetHost == "" {
		p.TargetHost = "code-docker"
	}
	if err := validateHost("targetHost", p.TargetHost); err != nil {
		return Publish{}, err
	}
	if err := validatePort("tailscalePort", p.TailscalePort); err != nil {
		return Publish{}, err
	}
	if err := validatePort("localPort", p.LocalPort); err != nil {
		return Publish{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return Publish{}, err
	}
	found := false
	for i, e := range cfg.Publish {
		if e.Name == name {
			cfg.Publish[i] = p
			found = true
			break
		}
	}
	if !found {
		return Publish{}, ErrPublishNotFound
	}
	if err := save(path, cfg); err != nil {
		return Publish{}, err
	}
	return p, nil
}

func DeletePublish(path, name string) error {
	mu.Lock()
	defer mu.Unlock()
	cfg, err := load(path)
	if err != nil {
		return err
	}
	found := false
	kept := make([]Publish, 0, len(cfg.Publish))
	for _, e := range cfg.Publish {
		if e.Name == name {
			found = true
			continue
		}
		kept = append(kept, e)
	}
	if !found {
		return ErrPublishNotFound
	}
	cfg.Publish = kept
	return save(path, cfg)
}
