package main

import "os"

type Config struct {
	Addr                string
	SupervisorSock      string
	SSHAuthorizedKeys   string
	GitConfigPath       string
	SSHClientConfig     string
	SSHKeysDir          string
	GitCredentialsPath  string
	StaticDir           string
	TailscaleConfigPath string
	SSHSigningKeyPath   string
	VectorLogDir        string
	SystemDiskPath      string
	ClaudeBinPath       string
	ClaudeConfigDir     string
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	return Config{
		Addr:                getenv("WEBMANAGER_ADDR", ":81"),
		SupervisorSock:      getenv("SUPERVISOR_SOCK", "/run/supervisor.sock"),
		SSHAuthorizedKeys:   getenv("SSH_AUTHORIZED_KEYS", "/code/.ssh/authorized_keys"),
		GitConfigPath:       getenv("GIT_CONFIG_PATH", "/code/.gitconfig"),
		SSHClientConfig:     getenv("SSH_CLIENT_CONFIG", "/code/.ssh/config"),
		SSHKeysDir:          getenv("SSH_KEYS_DIR", "/code/.ssh/keys"),
		GitCredentialsPath:  getenv("GIT_CREDENTIALS_PATH", "/code/.git-credentials"),
		StaticDir:           getenv("WEBMANAGER_STATIC_DIR", "./static"),
		TailscaleConfigPath: getenv("TAILSCALE_CONFIG_PATH", "/code/.tailscale/config.yaml"),
		SSHSigningKeyPath:   getenv("SSH_SIGNING_KEY_PATH", "/code/.ssh/signing_key"),
		VectorLogDir:        getenv("VECTOR_LOG_DIR", "/code/.vector/logs"),
		SystemDiskPath:      getenv("SYSTEM_DISK_PATH", "/code"),
		ClaudeBinPath:       getenv("WEBMANAGER_CLAUDE_BINPATH", ""),
		ClaudeConfigDir:     getenv("CLAUDE_CONFIG_DIR", "/code/.claude"),
	}
}
