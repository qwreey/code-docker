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

	"webmanager/internal/supervisor"
)

func main() {
	cfg := loadConfig()
	s := &Server{
		cfg: cfg,
		sup: supervisor.NewClient(cfg.SupervisorSock),
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

	mux.Handle("GET /", staticHandler(cfg.StaticDir))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
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
