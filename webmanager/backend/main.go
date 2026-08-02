package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"webmanager/internal/cgroup"
	"webmanager/internal/procinfo"
	"webmanager/internal/supervisor"
)

func main() {
	cfg := loadConfig()
	s := &Server{
		cfg:           cfg,
		sup:           supervisor.NewClient(cfg.SupervisorSock),
		procSampler:   procinfo.NewSampler(),
		cgroupSampler: cgroup.NewSampler(),
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/supervisor/processes", s.handleListProcesses)
	mux.HandleFunc("POST /api/supervisor/processes/{name}/start", s.handleStartProcess)
	mux.HandleFunc("POST /api/supervisor/processes/{name}/stop", s.handleStopProcess)
	mux.HandleFunc("POST /api/supervisor/processes/{name}/restart", s.handleRestartProcess)
	mux.HandleFunc("GET /api/supervisor/processes/{name}/log", s.handleProcessLog)

	mux.HandleFunc("GET /api/ssh/keys", s.handleListSSHKeys)
	mux.HandleFunc("POST /api/ssh/keys", s.handleAddSSHKey)
	mux.HandleFunc("DELETE /api/ssh/keys/{id}", s.handleDeleteSSHKey)

	mux.HandleFunc("GET /api/git/config", s.handleGetGitConfig)
	mux.HandleFunc("PUT /api/git/config", s.handlePutGitConfig)
	mux.HandleFunc("GET /api/git/ssh-hosts", s.handleListSSHHosts)
	mux.HandleFunc("POST /api/git/ssh-hosts", s.handleAddSSHHost)
	mux.HandleFunc("DELETE /api/git/ssh-hosts/{host}", s.handleDeleteSSHHost)
	mux.HandleFunc("GET /api/git/credentials", s.handleListCredentials)
	mux.HandleFunc("POST /api/git/credentials", s.handleAddCredential)
	mux.HandleFunc("DELETE /api/git/credentials/{host}", s.handleDeleteCredential)

	mux.HandleFunc("GET /api/git/signing", s.handleGetGitSigning)
	mux.HandleFunc("PUT /api/git/signing", s.handlePutGitSigning)
	mux.HandleFunc("POST /api/git/signing/ssh-key", s.handleGenerateSSHSigningKey)
	mux.HandleFunc("GET /api/git/gpg-keys", s.handleListGPGKeys)
	mux.HandleFunc("POST /api/git/gpg-keys", s.handleGenerateGPGKey)
	mux.HandleFunc("GET /api/git/gpg-keys/{keyId}/public", s.handleGetGPGPublicKey)
	mux.HandleFunc("DELETE /api/git/gpg-keys/{keyId}", s.handleDeleteGPGKey)

	mux.HandleFunc("GET /api/tailscale/config", s.handleGetTailscaleConfig)
	mux.HandleFunc("PUT /api/tailscale/config", s.handlePutTailscaleConfig)
	mux.HandleFunc("GET /api/tailscale/forwards", s.handleListTailscaleForwards)
	mux.HandleFunc("POST /api/tailscale/forwards", s.handleAddTailscaleForward)
	mux.HandleFunc("DELETE /api/tailscale/forwards/{name}", s.handleDeleteTailscaleForward)
	mux.HandleFunc("GET /api/tailscale/publish", s.handleListTailscalePublish)
	mux.HandleFunc("POST /api/tailscale/publish", s.handleAddTailscalePublish)
	mux.HandleFunc("DELETE /api/tailscale/publish/{name}", s.handleDeleteTailscalePublish)

	mux.HandleFunc("GET /api/logs/apps", s.handleListLogApps)
	mux.HandleFunc("GET /api/logs/entries", s.handleListLogEntries)

	mux.HandleFunc("GET /api/processes", s.handleListSystemProcesses)
	mux.HandleFunc("POST /api/processes/{pid}/signal", s.handleSignalProcess)
	mux.HandleFunc("GET /api/ports", s.handleListPorts)

	mux.HandleFunc("GET /api/system/resources", s.handleSystemResources)

	mux.Handle("GET /", staticHandler(cfg.StaticDir))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: limitRequestBody(mux),
	}

	go func() {
		log.Printf("webmanager listening on %s", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
