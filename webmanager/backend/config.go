package main

import "os"

type Config struct {
	Addr                 string
	SupervisorSock       string
	SSHAuthorizedKeys    string
	GitConfigPath        string
	SSHClientConfig      string
	SSHKeysDir           string
	SSHKnownHostsPath    string
	GitCredentialsPath   string
	StaticDir            string
	TailscaleConfigPath  string
	TailscaleBinPath     string
	TailscaleLoginServer string
	SSHSigningKeyPath    string
	VectorLogDir         string
	SystemDiskPath       string
	ClaudeBinPath        string
	ClaudeConfigDir      string
	ClaudePrefsPath      string
	MiseBinPath          string
	ProjectsPaths        string
	ProjectsCachePath    string
	ProjectsStaleAfter   string
	ProjectsOldDays      string
	ProjectsPatternsPath string
	CodeServerURL        string

	SystemHistoryIntervalSeconds string
	SystemHistoryWindowMinutes   string

	RecommendationsDefaultPath  string
	RecommendationsOverridePath string
	CodeServerBinPath           string
	CodeServerUserDataDir       string
	CodeServerExtensionsDir     string

	SupervisorMetadataDefaultPath  string
	SupervisorMetadataOverridePath string

	// AuthPasswordHash gates the web terminal and file manager routes (see
	// internal/authgate) behind RequirePassword. Empty (default) means the
	// gate is disabled — those routes stay open, matching webmanager's
	// existing reverse-proxy-only trust model.
	AuthPasswordHash string

	// FilesRoot defaults to /code rather than / — narrower, safer default;
	// an operator who wants full-container browsing can widen it.
	FilesRoot           string
	FilesMaxUploadBytes string

	// TerminalSettingsPath is where the web terminal's user-customizable
	// keybindings/color themes are persisted (see internal/terminalsettings).
	TerminalSettingsPath string

	// TerminalProfilesPath is where the terminal Home tab's user-defined
	// launch profiles (label + optional cwd/initial command) are persisted
	// (see internal/terminalprofiles).
	TerminalProfilesPath string

	// SidebarOrderPath is where the user's drag-and-drop sidebar tab order
	// is persisted (see internal/uiprefs). Not gated — purely cosmetic.
	SidebarOrderPath string

	// DiskBreakdownRoot/DiskBreakdownCachePath back the Task Manager's
	// per-top-level-directory disk breakdown (see internal/diskusage) — a
	// different question from SystemDiskPath above (which is one statfs
	// number for a single configured mount). Root defaults to "/" (the
	// container's own root filesystem), not SystemDiskPath's default /code.
	DiskBreakdownRoot      string
	DiskBreakdownCachePath string

	// TerminalSessionIdleTimeout/TerminalSessionScrollbackBytes back M2's
	// named session registry (internal/termsession) — an idle, unpinned
	// session is reaped after this long with no attached client; pinned
	// sessions are exempt entirely (see terminal-plan.md's "영속 세션 토글").
	TerminalSessionIdleTimeout     string
	TerminalSessionScrollbackBytes string

	// EnvTemplatePath points at the image's shipped example-env.webmanager
	// (see .claude/env-migration-plan.md) — `webmanager --env-migrate` reads
	// it to know the current key set/defaults, and startup reads just its
	// WEBMANAGER_ENV_VERSION line to warn if .env.webmanager is stale.
	// Deliberately NOT baked in via go:embed: a path lets an operator
	// running multiple instances bind-mount their own template (e.g. with
	// org-mandated #!important keys) without rebuilding the image.
	// Deliberately NOT documented in example-env.webmanager itself (unlike
	// every other WEBMANAGER_* var) — that file IS the thing this path
	// points at and .env.webmanager gets rewritten by the migration tool,
	// so referencing this path from inside it would be self-referential.
	// See docker-compose.yml for where it's actually meant to be set.
	EnvTemplatePath string

	// EnvVersion is .env.webmanager's own WEBMANAGER_ENV_VERSION value (set
	// via env_file, not this var directly) — compared at startup against
	// EnvTemplatePath's current version to warn when the running file
	// predates the image's example-env.webmanager. Don't hand-edit this in
	// .env.webmanager; `--env-migrate` manages it via #!important.
	EnvVersion string

	// EnvVersionDismissPath persists whether the user has already
	// acknowledged the current env-version-mismatch warning (see
	// internal/envversionprefs) — not gated, purely a "don't nag me again
	// about this exact version" UI preference, same tier as SidebarOrderPath.
	EnvVersionDismissPath string
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
		SSHKnownHostsPath:   getenv("WEBMANAGER_SSH_KNOWN_HOSTS_PATH", "/code/.ssh/known_hosts"),
		GitCredentialsPath:  getenv("GIT_CREDENTIALS_PATH", "/code/.git-credentials"),
		StaticDir:           getenv("WEBMANAGER_STATIC_DIR", "./static"),
		TailscaleConfigPath: getenv("TAILSCALE_CONFIG_PATH", "/code/.tailscale/config.yaml"),
		TailscaleBinPath:    getenv("WEBMANAGER_TAILSCALE_BINPATH", ""),
		// Same env var tailscale-service.default.sh reads, so an on-demand
		// `tailscale up` triggered from here uses the same login server.
		TailscaleLoginServer: getenv("TAILSCALE_LOGIN_SERVER", ""),
		SSHSigningKeyPath:    getenv("SSH_SIGNING_KEY_PATH", "/code/.ssh/signing_key"),
		VectorLogDir:         getenv("VECTOR_LOG_DIR", "/code/.vector/logs"),
		SystemDiskPath:       getenv("SYSTEM_DISK_PATH", "/code"),
		ClaudeBinPath:        getenv("WEBMANAGER_CLAUDE_BINPATH", ""),
		ClaudeConfigDir:      getenv("CLAUDE_CONFIG_DIR", "/code/.claude"),
		ClaudePrefsPath:      getenv("WEBMANAGER_CLAUDE_PREFS_PATH", "/code/.webmanager/claude-prefs.json"),
		MiseBinPath:          getenv("WEBMANAGER_MISE_BINPATH", ""),
		ProjectsPaths:        getenv("WEBMANAGER_PROJECTS_PATH", "/code/Projects"),
		ProjectsCachePath:    getenv("WEBMANAGER_PROJECTS_CACHE_PATH", "/code/.webmanager/projects-cache.json"),
		ProjectsStaleAfter:   getenv("WEBMANAGER_PROJECTS_STALE_AFTER", "1h"),
		ProjectsOldDays:      getenv("WEBMANAGER_PROJECTS_OLD_DAYS", "90"),
		ProjectsPatternsPath: getenv("WEBMANAGER_PROJECTS_PATTERNS_PATH", "/code/.webmanager/projects-patterns.yaml"),
		CodeServerURL:        getenv("WEBMANAGER_CODE_SERVER_URL", ""),

		SystemHistoryIntervalSeconds: getenv("WEBMANAGER_SYSTEM_HISTORY_INTERVAL_SECONDS", "5"),
		SystemHistoryWindowMinutes:   getenv("WEBMANAGER_SYSTEM_HISTORY_WINDOW_MINUTES", "10"),

		RecommendationsDefaultPath:  getenv("WEBMANAGER_RECOMMENDATIONS_DEFAULT_PATH", "/etc/code-docker/recommendations.default.yaml"),
		RecommendationsOverridePath: getenv("WEBMANAGER_RECOMMENDATIONS_OVERRIDE_PATH", "/etc/code-docker/recommendations.override.yaml"),
		CodeServerBinPath:           getenv("WEBMANAGER_CODE_SERVER_BIN", "/code/.server/code-server/bin/code-server"),
		CodeServerUserDataDir:       getenv("WEBMANAGER_CODE_SERVER_USER_DATA_DIR", "/code/.server/user-data"),
		CodeServerExtensionsDir:     getenv("WEBMANAGER_CODE_SERVER_EXTENSIONS_DIR", "/code/.server/extensions"),

		SupervisorMetadataDefaultPath:  getenv("WEBMANAGER_SUPERVISOR_METADATA_DEFAULT_PATH", "/etc/code-docker/supervisor-metadata.default.yaml"),
		SupervisorMetadataOverridePath: getenv("WEBMANAGER_SUPERVISOR_METADATA_OVERRIDE_PATH", "/etc/code-docker/supervisor-metadata.override.yaml"),

		AuthPasswordHash: getenv("WEBMANAGER_AUTH_PASSWORD_HASH", ""),

		FilesRoot:           getenv("WEBMANAGER_FILES_ROOT", "/code"),
		FilesMaxUploadBytes: getenv("WEBMANAGER_FILES_MAX_UPLOAD_BYTES", "2147483648"),

		TerminalSettingsPath: getenv("WEBMANAGER_TERMINAL_SETTINGS_PATH", "/code/.webmanager/terminal-settings.json"),
		TerminalProfilesPath: getenv("WEBMANAGER_TERMINAL_PROFILES_PATH", "/code/.webmanager/terminal-profiles.json"),
		SidebarOrderPath:     getenv("WEBMANAGER_SIDEBAR_ORDER_PATH", "/code/.webmanager/sidebar-order.json"),

		DiskBreakdownRoot:      getenv("SYSTEM_DISK_BREAKDOWN_ROOT", "/"),
		DiskBreakdownCachePath: getenv("WEBMANAGER_DISK_BREAKDOWN_CACHE_PATH", "/code/.webmanager/disk-breakdown-cache.json"),

		TerminalSessionIdleTimeout:     getenv("WEBMANAGER_TERMINAL_SESSION_IDLE_TIMEOUT", "30m"),
		TerminalSessionScrollbackBytes: getenv("WEBMANAGER_TERMINAL_SESSION_SCROLLBACK_BYTES", "262144"),

		EnvTemplatePath:       getenv("WEBMANAGER_ENV_TEMPLATE_PATH", "/etc/code-docker/webmanager/example-env.webmanager"),
		EnvVersion:            getenv("WEBMANAGER_ENV_VERSION", ""),
		EnvVersionDismissPath: getenv("WEBMANAGER_ENV_VERSION_DISMISS_PATH", "/code/.webmanager/env-version-dismiss.json"),
	}
}
