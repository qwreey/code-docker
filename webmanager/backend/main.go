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
	"webmanager/internal/mise"
	"webmanager/internal/procinfo"
	"webmanager/internal/projects"
	"webmanager/internal/supervisor"
)

func main() {
	cfg := loadConfig()

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
	gate := authgate.New(authPasswordHash)

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
		miseJobs: mise.NewJobStore(),
		gate:     gate,
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
	mux.Handle("DELETE /api/ssh/keys/{id}", gate.RequirePassword(http.HandlerFunc(s.handleDeleteSSHKey)))

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

	// Gated entirely (reads included, unlike the rest of webmanager): log
	// content can leak secrets, so even listing/viewing requires unlock.
	mux.Handle("GET /api/logs/apps", gate.RequirePassword(http.HandlerFunc(s.handleListLogApps)))
	mux.Handle("GET /api/logs/entries", gate.RequirePassword(http.HandlerFunc(s.handleListLogEntries)))
	mux.Handle("GET /api/logs/range", gate.RequirePassword(http.HandlerFunc(s.handleLogRange)))

	mux.HandleFunc("GET /api/processes", s.handleListSystemProcesses)
	mux.HandleFunc("POST /api/processes/{pid}/signal", s.handleSignalProcess)
	mux.HandleFunc("GET /api/ports", s.handleListPorts)

	mux.HandleFunc("GET /api/system/resources", s.handleSystemResources)
	mux.HandleFunc("GET /api/system/resources/history", s.handleSystemResourcesHistory)

	mux.HandleFunc("GET /api/claude/status", s.handleClaudeStatus)
	mux.HandleFunc("GET /api/claude/plugins", s.handleClaudePlugins)

	mux.HandleFunc("GET /api/projects", s.handleListProjects)
	mux.HandleFunc("POST /api/projects/scan", s.handleScanProjects)
	mux.HandleFunc("POST /api/projects/rescan", s.handleRescanProject)

	mux.HandleFunc("GET /api/recommendations", s.handleGetRecommendations)
	mux.HandleFunc("GET /api/code-extensions", s.handleListCodeExtensions)
	mux.HandleFunc("POST /api/code-extensions", s.handleInstallCodeExtension)

	mux.HandleFunc("GET /api/mise/tools", s.handleListMiseTools)
	mux.HandleFunc("POST /api/mise/tools", s.handleCreateMiseTool)
	mux.HandleFunc("DELETE /api/mise/tools", s.handleDeleteMiseTool)
	mux.HandleFunc("GET /api/mise/env", s.handleMiseEnv)
	mux.HandleFunc("GET /api/mise/jobs/{id}", s.handleMiseJobStatus)

	// Not gated by RequirePassword: handleAuthUnlock is how a locked-out
	// client unlocks in the first place, and handleAuthStatus lets the
	// frontend render the right prompt state without guessing from a 401.
	mux.HandleFunc("POST /api/auth/unlock", s.handleAuthUnlock)
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)

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

	mux.Handle("GET /", staticHandler(cfg.StaticDir))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: limitRequestBody(mux),
	}

	historyCtx, cancelHistory := context.WithCancel(context.Background())
	defer cancelHistory()
	go s.resourceHistory.Run(historyCtx)

	go func() {
		log.Printf("webmanager listening on %s", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	cancelHistory()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
