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
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const ConfigPath = "/var/lib/code-docker-router/tailscale/config.yaml"

// Forward pulls a remote tailnet peer's port into the container (socat +
// SOCKS5). RetryInterval of 0 means "inherit the global default".
type Forward struct {
	Name          string `yaml:"name" json:"name"`
	LocalPort     int    `yaml:"local_port" json:"localPort"`
	RemoteHost    string `yaml:"remote_host" json:"remoteHost"`
	RemotePort    int    `yaml:"remote_port" json:"remotePort"`
	RetryInterval int    `yaml:"retry_intervall,omitempty" json:"retryInterval"`
}

// Publish exposes a local container port to the tailnet via `tailscale serve`.
type Publish struct {
	Name          string `yaml:"name" json:"name"`
	TailscalePort int    `yaml:"tailscale_port" json:"tailscalePort"`
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
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func GetGlobalConfig(path string) (GlobalConfig, error) {
	cfg, err := load(path)
	if err != nil {
		return GlobalConfig{}, err
	}
	return GlobalConfig{SocksAddress: cfg.SocksAddress, RetryInterval: cfg.RetryInterval}, nil
}

func SetGlobalConfig(path string, g GlobalConfig) error {
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
	if f.Name == "" || f.LocalPort == 0 || f.RemoteHost == "" || f.RemotePort == 0 {
		return Forward{}, errors.New("name, localPort, remoteHost and remotePort are required")
	}
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

func DeleteForward(path, name string) error {
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
	if p.Name == "" || p.TailscalePort == 0 || p.LocalPort == 0 {
		return Publish{}, errors.New("name, tailscalePort and localPort are required")
	}
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

func DeletePublish(path, name string) error {
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
