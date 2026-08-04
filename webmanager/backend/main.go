package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"webmanager/internal/authgate"
	"webmanager/internal/cgroup"
	"webmanager/internal/claudecode"
	"webmanager/internal/diskusage"
	"webmanager/internal/envmigrate"
	"webmanager/internal/mise"
	"webmanager/internal/procinfo"
	"webmanager/internal/projects"
	"webmanager/internal/sessionheartbeat"
	"webmanager/internal/supervisor"
	"webmanager/internal/tailscale"
	"webmanager/internal/termsession"
)

func main() {
	// CLI helper mode: `webmanager --hash-password` computes an argon2id
	// hash for WEBMANAGER_AUTH_PASSWORD_HASH and exits — never starts the
	// server. See hashpassword.go's doc comment.
	if len(os.Args) > 1 && os.Args[1] == "--hash-password" {
		os.Exit(hashPasswordCmd())
	}
	// CLI helper mode: `webmanager --env-migrate` reconciles a piped-in
	// .env.webmanager against this image's example-env.webmanager and exits
	// — never starts the server. See envmigratecmd.go's doc comment.
	if len(os.Args) > 1 && os.Args[1] == "--env-migrate" {
		os.Exit(envMigrateCmd(loadConfig()))
	}

	cfg := loadConfig()

	// Env-version mismatch check (webmanager/.claude/env-migration-plan.md)
	// — a stale .env.webmanager mostly still works fine (every key has a
	// sane default), so this is a warning, not a startup failure. An
	// unreadable template just means the check is skipped, not a crash.
	envTemplateVersion := ""
	if data, err := os.ReadFile(cfg.EnvTemplatePath); err != nil {
		log.Printf("main: couldn't read env template at %s for version check: %v", cfg.EnvTemplatePath, err)
	} else {
		envTemplateVersion = envmigrate.ParseVersion(string(data))
		if envTemplateVersion != "" && envTemplateVersion != cfg.EnvVersion {
			log.Printf("main: ⚠️ .env.webmanager version is %q but this image's example-env.webmanager is at %q — run `webmanager --env-migrate` (see README) to pick up added/changed settings", cfg.EnvVersion, envTemplateVersion)
		}
	}

	// Cross-check against /etc/environment: the whole point of storing
	// this hash only in a process-start-time env var (see
	// webmanager/.claude/terminal-plan.md's "인증" section) is that
	// changing it requires host-side docker-compose.yml/.env access, not
	// just container shell access. If the same var is also defined in
	// /etc/environment, treat it as untrusted and fail open (leave the
	// gate unconfigured) rather than crash the whole server over it.
	authPasswordHash := cfg.AuthPasswordHash
	if authPasswordHash != "" && authgate.EtcEnvironmentDefines("WEBMANAGER_AUTH_PASSWORD_HASH") {
		log.Printf("main: REFUSING to honor WEBMANAGER_AUTH_PASSWORD_HASH because it's also set in /etc/environment — this could mean it was tampered with from inside the container")
		authPasswordHash = ""
	}
	gate := authgate.New(authPasswordHash, cfg.AuthCookieDomain)

	historyIntervalSeconds, err := strconv.Atoi(cfg.SystemHistoryIntervalSeconds)
	if err != nil {
		log.Printf("main: invalid system history interval %q, using 5: %v", cfg.SystemHistoryIntervalSeconds, err)
		historyIntervalSeconds = 5
	}
	historyWindowMinutes, err := strconv.Atoi(cfg.SystemHistoryWindowMinutes)
	if err != nil {
		log.Printf("main: invalid system history window %q, using 10: %v", cfg.SystemHistoryWindowMinutes, err)
		historyWindowMinutes = 10
	}

	termIdleTimeout, err := time.ParseDuration(cfg.TerminalSessionIdleTimeout)
	if err != nil {
		log.Printf("main: invalid terminal session idle timeout %q, using 30m: %v", cfg.TerminalSessionIdleTimeout, err)
		termIdleTimeout = 30 * time.Minute
	}
	termScrollbackBytes, err := strconv.Atoi(cfg.TerminalSessionScrollbackBytes)
	if err != nil {
		log.Printf("main: invalid terminal session scrollback bytes %q, using 262144: %v", cfg.TerminalSessionScrollbackBytes, err)
		termScrollbackBytes = 262144
	}

	s := &Server{
		cfg:         cfg,
		sup:         supervisor.NewClient(cfg.SupervisorSock),
		procSampler: procinfo.NewSampler(),
		// s.cgroupSampler backs the live GET /api/system/resources
		// endpoint (one CPU delta-sample per incoming HTTP request).
		// resourceHistory below gets its own separate *cgroup.Sampler
		// internally (see HistorySampler's doc comment) — never reuse
		// this instance for it, the two callers' irregular vs. regular
		// polling would corrupt each other's delta baseline.
		cgroupSampler:   cgroup.NewSampler(),
		resourceHistory: cgroup.NewHistorySampler(historyIntervalSeconds, historyWindowMinutes*60),
		hostCPUSampler:  cgroup.NewHostCPUSampler(),
		hostSensors:     cgroup.NewHostSensors(),
		projectScanner: projects.NewScanner(
			cfg.ProjectsPaths,
			cfg.ProjectsCachePath,
			cfg.ProjectsPatternsPath,
			cfg.ProjectsStaleAfter,
			cfg.ProjectsOldDays,
			cfg.CodeServerURL,
		),
		miseJobs:           mise.NewJobStore(),
		loginMgr:           claudecode.NewLoginManager(),
		tailscaleLogin:     tailscale.NewLoginManager(),
		diskUsage:          diskusage.NewAnalyzer(cfg.DiskBreakdownRoot, cfg.DiskBreakdownCachePath),
		termSessions:       termsession.NewRegistry(rootLoginShell, termScrollbackBytes, termIdleTimeout),
		sessionHeartbeats:  sessionheartbeat.NewStore(),
		gate:               gate,
		envTemplateVersion: envTemplateVersion,
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/supervisor/processes", s.handleListProcesses)
	mux.Handle("POST /api/supervisor/processes/{name}/start", gate.RequirePassword(http.HandlerFunc(s.handleStartProcess)))
	mux.Handle("POST /api/supervisor/processes/{name}/stop", gate.RequirePassword(http.HandlerFunc(s.handleStopProcess)))
	mux.Handle("POST /api/supervisor/processes/{name}/restart", gate.RequirePassword(http.HandlerFunc(s.handleRestartProcess)))
	// Gated like Logs below (not just writes): per-program log content can
	// leak secrets just as easily as the aggregated Logs view.
	mux.Handle("GET /api/supervisor/processes/{name}/log", gate.RequirePassword(http.HandlerFunc(s.handleProcessLog)))

	mux.HandleFunc("GET /api/ssh/keys", s.handleListSSHKeys)
	mux.Handle("POST /api/ssh/keys", gate.RequirePassword(http.HandlerFunc(s.handleAddSSHKey)))
	mux.Handle("PUT /api/ssh/keys/{id}", gate.RequirePassword(http.HandlerFunc(s.handleUpdateSSHKey)))
	mux.Handle("DELETE /api/ssh/keys/{id}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteSSHKey)))
	mux.Handle("POST /api/ssh/keys/comments", gate.RequirePassword(http.HandlerFunc(s.handleAddSSHComment)))
	mux.Handle("PUT /api/ssh/keys/comments/{id}", gate.RequirePassword(http.HandlerFunc(s.handleUpdateSSHComment)))
	mux.Handle("DELETE /api/ssh/keys/comments/{id}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteSSHComment)))
	mux.Handle("POST /api/ssh/keys/reorder", gate.RequirePassword(http.HandlerFunc(s.handleReorderSSHKeys)))

	mux.HandleFunc("GET /api/git/config", s.handleGetGitConfig)
	mux.Handle("PUT /api/git/config", gate.RequirePassword(http.HandlerFunc(s.handlePutGitConfig)))
	mux.HandleFunc("GET /api/git/ssh-hosts", s.handleListSSHHosts)
	mux.Handle("POST /api/git/ssh-hosts", gate.RequirePassword(http.HandlerFunc(s.handleAddSSHHost)))
	mux.Handle("DELETE /api/git/ssh-hosts/{host}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteSSHHost)))
	mux.HandleFunc("GET /api/git/known-hosts", s.handleListKnownHosts)
	mux.Handle("POST /api/git/known-hosts", gate.RequirePassword(http.HandlerFunc(s.handleAddKnownHost)))
	mux.Handle("DELETE /api/git/known-hosts/{index}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteKnownHost)))
	mux.HandleFunc("GET /api/git/credentials", s.handleListCredentials)
	mux.Handle("POST /api/git/credentials", gate.RequirePassword(http.HandlerFunc(s.handleAddCredential)))
	mux.Handle("DELETE /api/git/credentials/{host}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteCredential)))
	mux.HandleFunc("GET /api/git/lfs/status", s.handleGetLFSStatus)
	mux.Handle("POST /api/git/lfs/install", gate.RequirePassword(http.HandlerFunc(s.handleInstallLFS)))
	mux.HandleFunc("GET /api/git/config/raw", s.handleGetGitConfigRaw)
	mux.Handle("PUT /api/git/config/raw", gate.RequirePassword(http.HandlerFunc(s.handlePutGitConfigRaw)))

	mux.HandleFunc("GET /api/git/signing", s.handleGetGitSigning)
	mux.Handle("PUT /api/git/signing", gate.RequirePassword(http.HandlerFunc(s.handlePutGitSigning)))
	mux.Handle("POST /api/git/signing/ssh-key", gate.RequirePassword(http.HandlerFunc(s.handleGenerateSSHSigningKey)))
	mux.HandleFunc("GET /api/git/gpg-keys", s.handleListGPGKeys)
	mux.Handle("POST /api/git/gpg-keys", gate.RequirePassword(http.HandlerFunc(s.handleGenerateGPGKey)))
	mux.HandleFunc("GET /api/git/gpg-keys/{keyId}/public", s.handleGetGPGPublicKey)
	mux.Handle("DELETE /api/git/gpg-keys/{keyId}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteGPGKey)))

	mux.HandleFunc("GET /api/tailscale/config", s.handleGetTailscaleConfig)
	mux.Handle("PUT /api/tailscale/config", gate.RequirePassword(http.HandlerFunc(s.handlePutTailscaleConfig)))
	mux.HandleFunc("GET /api/tailscale/forwards", s.handleListTailscaleForwards)
	mux.Handle("POST /api/tailscale/forwards", gate.RequirePassword(http.HandlerFunc(s.handleAddTailscaleForward)))
	mux.Handle("DELETE /api/tailscale/forwards/{name}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteTailscaleForward)))
	mux.HandleFunc("GET /api/tailscale/publish", s.handleListTailscalePublish)
	mux.Handle("POST /api/tailscale/publish", gate.RequirePassword(http.HandlerFunc(s.handleAddTailscalePublish)))
	mux.Handle("DELETE /api/tailscale/publish/{name}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteTailscalePublish)))
	mux.HandleFunc("GET /api/tailscale/status", s.handleTailscaleStatus)
	mux.Handle("POST /api/tailscale/login/start", gate.RequirePassword(http.HandlerFunc(s.handleTailscaleLoginStart)))
	mux.Handle("POST /api/tailscale/login/cancel", gate.RequirePassword(http.HandlerFunc(s.handleTailscaleLoginCancel)))

	// internal/devproxy — Caddyfile fragments for the dev-proxy wildcard
	// subdomain (see docs/dev-proxy.md). Reads open, writes gated, same
	// convention as tailscale forwards/publish above.
	mux.HandleFunc("GET /api/dev-proxy/exposes", s.handleListDevProxyExposes)
	mux.Handle("POST /api/dev-proxy/exposes", gate.RequirePassword(http.HandlerFunc(s.handleCreateDevProxyExpose)))
	mux.Handle("PUT /api/dev-proxy/exposes/{name}", gate.RequirePassword(http.HandlerFunc(s.handleUpdateDevProxyExpose)))
	mux.Handle("DELETE /api/dev-proxy/exposes/{name}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteDevProxyExpose)))
	mux.Handle("POST /api/dev-proxy/reload", gate.RequirePassword(http.HandlerFunc(s.handleReloadDevProxy)))

	// Gated entirely (reads included, unlike the rest of webmanager): log
	// content can leak secrets, so even listing/viewing requires unlock.
	mux.Handle("GET /api/logs/apps", gate.RequirePassword(http.HandlerFunc(s.handleListLogApps)))
	mux.Handle("GET /api/logs/entries", gate.RequirePassword(http.HandlerFunc(s.handleListLogEntries)))
	mux.Handle("GET /api/logs/range", gate.RequirePassword(http.HandlerFunc(s.handleLogRange)))

	mux.HandleFunc("GET /api/processes", s.handleListSystemProcesses)
	mux.Handle("POST /api/processes/{pid}/signal", gate.RequirePassword(http.HandlerFunc(s.handleSignalProcess)))
	mux.HandleFunc("GET /api/ports", s.handleListPorts)

	mux.HandleFunc("GET /api/system/resources", s.handleSystemResources)
	mux.HandleFunc("GET /api/system/resources/history", s.handleSystemResourcesHistory)

	// Cached, explicit-trigger-only like /api/projects above — a full `du`
	// over the container's root filesystem can take a while, so it never
	// runs on a plain GET.
	mux.HandleFunc("GET /api/system/disk-breakdown", s.handleDiskBreakdown)
	mux.HandleFunc("POST /api/system/disk-breakdown/scan", s.handleScanDiskBreakdown)

	// dind is DOCKER_HOST=tcp://dind:2375 (plaintext, no auth) — same trust
	// boundary as the rest of code-docker-internal, not a new one (see
	// webmanager/.claude/dind-plan.md). Reads (list/logs/inspect) stay
	// ungated like the other read endpoints above, except inspect: it's the
	// one gated read among list/logs/inspect, because `docker inspect`
	// exposes a container's full config including plaintext env vars
	// (Config.Env, which may contain secrets from `docker run -e ...`) —
	// same shape as GET /api/supervisor/processes/{name}/log (handleProcessLog,
	// also gated below without wrapping its whole tab in <RequiresUnlock>).
	// start/stop/remove mutate state so they're wrapped in
	// gate.RequirePassword too, same as Supervisor's start/stop/restart and
	// every other write route below.
	mux.HandleFunc("GET /api/dind/containers", s.handleListDindContainers)
	mux.HandleFunc("GET /api/dind/images", s.handleListDindImages)
	mux.HandleFunc("GET /api/dind/containers/{id}/logs", s.handleDindContainerLogs)
	mux.Handle("GET /api/dind/containers/{id}/inspect", gate.RequirePassword(http.HandlerFunc(s.handleInspectDindContainer)))
	mux.Handle("POST /api/dind/containers/{id}/start", gate.RequirePassword(http.HandlerFunc(s.handleStartDindContainer)))
	mux.Handle("POST /api/dind/containers/{id}/stop", gate.RequirePassword(http.HandlerFunc(s.handleStopDindContainer)))
	mux.Handle("POST /api/dind/containers/{id}/remove", gate.RequirePassword(http.HandlerFunc(s.handleRemoveDindContainer)))

	mux.HandleFunc("GET /api/claude/status", s.handleClaudeStatus)
	mux.HandleFunc("GET /api/claude/mise-version", s.handleClaudeMiseVersion)
	mux.HandleFunc("GET /api/claude/plugins", s.handleClaudePlugins)
	mux.Handle("POST /api/claude/install", gate.RequirePassword(http.HandlerFunc(s.handleClaudeInstall)))
	mux.HandleFunc("GET /api/claude/prefs", s.handleClaudePrefsGet)
	mux.Handle("PUT /api/claude/prefs", gate.RequirePassword(http.HandlerFunc(s.handleClaudePrefsPut)))
	mux.Handle("POST /api/claude/login/start", gate.RequirePassword(http.HandlerFunc(s.handleClaudeLoginStart)))
	mux.Handle("GET /api/claude/login/{id}", gate.RequirePassword(http.HandlerFunc(s.handleClaudeLoginStatus)))
	mux.Handle("POST /api/claude/login/{id}/code", gate.RequirePassword(http.HandlerFunc(s.handleClaudeLoginCode)))
	mux.Handle("POST /api/claude/login/{id}/cancel", gate.RequirePassword(http.HandlerFunc(s.handleClaudeLoginCancel)))
	mux.Handle("GET /api/claude/sessions", gate.RequirePassword(http.HandlerFunc(s.handleClaudeSessions)))
	mux.Handle("GET /api/claude/sessions/{project}/{sessionId}", gate.RequirePassword(http.HandlerFunc(s.handleClaudeSessionLines)))

	mux.HandleFunc("GET /api/projects", s.handleListProjects)
	mux.HandleFunc("POST /api/projects/scan", s.handleScanProjects)
	mux.HandleFunc("POST /api/projects/rescan", s.handleRescanProject)
	// Destructive (os.RemoveAll under the hood), unlike the reads above — gated.
	mux.Handle("POST /api/projects/delete-reclaimable", gate.RequirePassword(http.HandlerFunc(s.handleDeleteReclaimable)))
	// Whole-project-folder delete, distinct from delete-reclaimable above — gated.
	mux.Handle("POST /api/projects/delete", gate.RequirePassword(http.HandlerFunc(s.handleDeleteProject)))

	// Git status/history — all reads (staging/commit/push/pull/merge are out
	// of scope for this round), so none of these are gated. See
	// handlers_projectgit.go's file doc comment.
	mux.HandleFunc("GET /api/projects/git/status", s.handleProjectGitStatus)
	mux.HandleFunc("GET /api/projects/git/log", s.handleProjectGitLog)
	mux.HandleFunc("GET /api/projects/git/diff/commit", s.handleProjectGitDiffCommit)
	mux.HandleFunc("GET /api/projects/git/diff/unstaged", s.handleProjectGitDiffUnstaged)
	mux.HandleFunc("GET /api/projects/git/diff/staged", s.handleProjectGitDiffStaged)
	mux.HandleFunc("GET /api/projects/git/remotes", s.handleProjectGitRemotes)
	mux.HandleFunc("GET /api/projects/git/branches", s.handleProjectGitBranches)
	mux.HandleFunc("GET /api/projects/git/tags", s.handleProjectGitTags)

	mux.HandleFunc("GET /api/recommendations", s.handleGetRecommendations)
	mux.HandleFunc("GET /api/code-extensions", s.handleListCodeExtensions)
	mux.Handle("POST /api/code-extensions", gate.RequirePassword(http.HandlerFunc(s.handleInstallCodeExtension)))
	mux.Handle("DELETE /api/code-extensions/{id}", gate.RequirePassword(http.HandlerFunc(s.handleUninstallCodeExtension)))

	mux.HandleFunc("GET /api/mise/tools", s.handleListMiseTools)
	mux.Handle("POST /api/mise/tools", gate.RequirePassword(http.HandlerFunc(s.handleCreateMiseTool)))
	mux.Handle("DELETE /api/mise/tools", gate.RequirePassword(http.HandlerFunc(s.handleDeleteMiseTool)))
	mux.HandleFunc("GET /api/mise/env", s.handleMiseEnv)
	mux.HandleFunc("GET /api/mise/jobs/{id}", s.handleMiseJobStatus)

	// Boolean, no sensitive content — same open-read tier as the rest.
	// Set by mise/extension/Claude Code install-or-uninstall completions
	// (see handlers_restartstatus.go), self-clears once code-server's live
	// PID no longer matches what was recorded.
	mux.HandleFunc("GET /api/system/restart-needed", s.handleRestartStatus)

	// Not gated by RequirePassword: handleAuthUnlock is how a locked-out
	// client unlocks in the first place, and handleAuthStatus lets the
	// frontend render the right prompt state without guessing from a 401.
	mux.HandleFunc("POST /api/auth/unlock", s.handleAuthUnlock)
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	// Not wrapped in RequirePassword — it IS the auth check (Caddy
	// forward_auth upstream for internal/devproxy, see handlers_auth.go).
	mux.HandleFunc("GET /api/auth/verify", s.handleAuthVerify)

	// session-heartbeat: see webmanager/.claude/qa-request/
	// session-heartbeat-plan-done.md for why this pair inverts the usual
	// reads-open/writes-gated convention. The POST comes from an anonymous
	// code-server tab (code-server itself runs with auth: none) with no
	// credential to present, so gating it would just break the feature; the
	// GET reveals what folders are open across every connected tab, which is
	// the side actually worth gating here.
	mux.HandleFunc("POST /api/sessions/heartbeat", s.handleSessionHeartbeat)
	mux.Handle("GET /api/sessions", gate.RequirePassword(http.HandlerFunc(s.handleListSessions)))
	mux.Handle("POST /api/sessions/{id}/close", gate.RequirePassword(http.HandlerFunc(s.handleRequestSessionClose)))

	mux.HandleFunc("GET /api/ui/sidebar-order", s.handleGetSidebarOrder)
	mux.HandleFunc("PUT /api/ui/sidebar-order", s.handlePutSidebarOrder)

	// Read-only status + a "don't nag me again about this version" write —
	// no gate, same tier as sidebar-order above (purely informational/UI
	// preference, no security relevance).
	mux.HandleFunc("GET /api/system/env-version", s.handleEnvVersion)
	mux.HandleFunc("POST /api/system/env-version/dismiss", s.handleDismissEnvVersion)

	// SECURITY: opens an unauthenticated-by-default, interactive root
	// shell (PTY) over WebSocket to anyone who can reach webmanager — no
	// login of its own beyond the fronting reverse proxy's forward-auth
	// like the rest of webmanager. An operator can additionally opt into a
	// shared password gate (internal/authgate) via
	// WEBMANAGER_AUTH_PASSWORD_HASH, which also covers the file manager
	// routes below — see handlers_terminal.go's doc comment and
	// internal/authgate's package doc.
	mux.Handle("GET /api/terminal", gate.RequirePassword(http.HandlerFunc(s.handleTerminal)))

	// Gated like GET /api/terminal above (reads included) — same "everything
	// about the terminal is sensitive" stance covers its persisted
	// keybindings/theme settings too.
	mux.Handle("GET /api/terminal/settings", gate.RequirePassword(http.HandlerFunc(s.handleGetTerminalSettings)))
	mux.Handle("PUT /api/terminal/settings", gate.RequirePassword(http.HandlerFunc(s.handlePutTerminalSettings)))

	// M2 named sessions (internal/termsession) — same gate as the terminal
	// itself above (listing session names/timestamps is far less sensitive
	// than the terminal content, but there's no reason to give it a weaker
	// bar than everything else terminal-related).
	mux.Handle("GET /api/terminal/sessions", gate.RequirePassword(http.HandlerFunc(s.handleListTerminalSessions)))
	mux.Handle("PATCH /api/terminal/sessions/{name}", gate.RequirePassword(http.HandlerFunc(s.handlePatchTerminalSession)))
	mux.Handle("DELETE /api/terminal/sessions/{name}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteTerminalSession)))

	// Home tab launch profiles (internal/terminalprofiles) — same gate as
	// the rest of the terminal feature.
	mux.Handle("GET /api/terminal/profiles", gate.RequirePassword(http.HandlerFunc(s.handleGetTerminalProfiles)))
	mux.Handle("PUT /api/terminal/profiles", gate.RequirePassword(http.HandlerFunc(s.handlePutTerminalProfiles)))

	// SECURITY: arbitrary filesystem read/write/delete under
	// WEBMANAGER_FILES_ROOT (default /code) — webmanager's single largest
	// risk surface alongside the terminal above and dind. Gated by the
	// same RequirePassword instance, so the two features share one
	// password/env var.
	mux.Handle("GET /api/files/list", gate.RequirePassword(http.HandlerFunc(s.handleFilesList)))
	mux.Handle("GET /api/files/stat", gate.RequirePassword(http.HandlerFunc(s.handleFilesStat)))
	mux.Handle("GET /api/files/download", gate.RequirePassword(http.HandlerFunc(s.handleFilesDownload)))
	mux.Handle("GET /api/files/content", gate.RequirePassword(http.HandlerFunc(s.handleFilesContentGet)))
	mux.Handle("PUT /api/files/content", gate.RequirePassword(http.HandlerFunc(s.handleFilesContentPut)))
	mux.Handle("POST /api/files/upload", gate.RequirePassword(http.HandlerFunc(s.handleFilesUpload)))
	mux.Handle("POST /api/files/mkdir", gate.RequirePassword(http.HandlerFunc(s.handleFilesMkdir)))
	mux.Handle("POST /api/files/rename", gate.RequirePassword(http.HandlerFunc(s.handleFilesRename)))
	mux.Handle("POST /api/files/move", gate.RequirePassword(http.HandlerFunc(s.handleFilesMove)))
	mux.Handle("POST /api/files/copy", gate.RequirePassword(http.HandlerFunc(s.handleFilesCopy)))
	mux.Handle("POST /api/files/delete", gate.RequirePassword(http.HandlerFunc(s.handleFilesDelete)))

	// Not under /api — this replaces code-server's own manifest.json in
	// place (see config/nginx.default.conf's `location = /manifest.json`).
	// Ungated like the other pure-read routes above: it's a passthrough of
	// something code-server already serves unauthenticated.
	mux.HandleFunc("GET /manifest.json", s.handleManifestPassthrough)

	mux.Handle("GET /", staticHandler(cfg.StaticDir))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: limitRequestBody(mux),
	}

	// Shared cancel-on-shutdown context for every long-lived background
	// loop (resource history sampling, terminal session idle GC).
	bgCtx, cancelBg := context.WithCancel(context.Background())
	defer cancelBg()
	go s.resourceHistory.Run(bgCtx)
	go s.termSessions.Run(bgCtx)
	go s.sessionHeartbeats.Run(bgCtx)

	go func() {
		log.Printf("webmanager listening on %s", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	cancelBg()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
