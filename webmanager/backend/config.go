package main

import "os"

type Config struct {
	Addr               string
	SupervisorSock     string
	SSHAuthorizedKeys  string
	GitConfigPath      string
	SSHClientConfig    string
	SSHKeysDir         string
	GitCredentialsPath string
	StaticDir          string
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	return Config{
		Addr:               getenv("WEBMANAGER_ADDR", ":81"),
		SupervisorSock:     getenv("SUPERVISOR_SOCK", "/run/supervisor.sock"),
		SSHAuthorizedKeys:  getenv("SSH_AUTHORIZED_KEYS", "/code/.ssh/authorized_keys"),
		GitConfigPath:      getenv("GIT_CONFIG_PATH", "/code/.gitconfig"),
		SSHClientConfig:    getenv("SSH_CLIENT_CONFIG", "/code/.ssh/config"),
		SSHKeysDir:         getenv("SSH_KEYS_DIR", "/code/.ssh/keys"),
		GitCredentialsPath: getenv("GIT_CREDENTIALS_PATH", "/code/.git-credentials"),
		StaticDir:          getenv("WEBMANAGER_STATIC_DIR", "./static"),
	}
}
