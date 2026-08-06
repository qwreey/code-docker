// router-manager: the Go backend for router (see router/plan.md for scope).
// Mirrors webmanager's own backend pattern (stdlib net/http, no framework).
// Deliberately private-only regardless of the auth gate below (no host port
// published for this service in docker-compose.yml, so it's only reachable
// from other code-docker-internal containers, e.g. code-docker's nginx via
// its /tailscale/, /dev-proxy/, /router-auth/ proxy routes - see
// .claude/backlog/functional-router-plan.md's "tailscale readonly API 노출
// 정책").
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"router/internal/authgate"
	"router/internal/tailscale"
)

// gate protects every mutating route below (reads stay open, writes are
// gated - same convention webmanager's own internal/authgate follows).
// Package-level rather than threaded through a server struct, matching this
// package's existing free-function handler style (see handlers_tailscale.go
// / handlers_devproxy.go's supervisorClient/tailscaleLogin package vars).
var gate *authgate.Gate

func main() {
	// CLI helper mode: `router-manager --hash-password` computes an argon2id
	// hash for ROUTER_MANAGER_AUTH_PASSWORD_HASH and exits - never starts the
	// server. See hashpassword.go's doc comment.
	if len(os.Args) > 1 && os.Args[1] == "--hash-password" {
		os.Exit(hashPasswordCmd())
	}

	addr := os.Getenv("ROUTER_MANAGER_ADDR")
	if addr == "" {
		addr = ":8091"
	}

	// Cross-check against /etc/environment: storing this hash only in a
	// process-start-time env var is the point (changing it needs host-side
	// docker-compose.yml/.env access, not just container shell access) - if
	// the same var is also defined in /etc/environment, treat it as
	// untrusted and fail open (leave the gate unconfigured) rather than
	// honor a value that could've been tampered with from inside the
	// container. Same check webmanager's own main.go does.
	authPasswordHash := os.Getenv("ROUTER_MANAGER_AUTH_PASSWORD_HASH")
	if authPasswordHash != "" && authgate.EtcEnvironmentDefines("ROUTER_MANAGER_AUTH_PASSWORD_HASH") {
		log.Printf("main: REFUSING to honor ROUTER_MANAGER_AUTH_PASSWORD_HASH because it's also set in /etc/environment - this could mean it was tampered with from inside the container")
		authPasswordHash = ""
	}
	gate = authgate.New(authPasswordHash)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/unlock", handleAuthUnlock)
	mux.HandleFunc("GET /api/auth/status", handleAuthStatus)

	mux.HandleFunc("GET /api/tailscale/state", handleTailscaleState)
	mux.HandleFunc("GET /api/tailscale/config", handleGetTailscaleConfig)
	mux.Handle("PUT /api/tailscale/config", gate.RequirePassword(http.HandlerFunc(handlePutTailscaleConfig)))
	mux.HandleFunc("GET /api/tailscale/forwards", handleListTailscaleForwards)
	mux.Handle("POST /api/tailscale/forwards", gate.RequirePassword(http.HandlerFunc(handleAddTailscaleForward)))
	mux.Handle("DELETE /api/tailscale/forwards/{name}", gate.RequirePassword(http.HandlerFunc(handleDeleteTailscaleForward)))
	mux.HandleFunc("GET /api/tailscale/publish", handleListTailscalePublish)
	mux.Handle("POST /api/tailscale/publish", gate.RequirePassword(http.HandlerFunc(handleAddTailscalePublish)))
	mux.Handle("DELETE /api/tailscale/publish/{name}", gate.RequirePassword(http.HandlerFunc(handleDeleteTailscalePublish)))
	mux.HandleFunc("GET /api/tailscale/status", handleTailscaleStatus)
	mux.Handle("POST /api/tailscale/login/start", gate.RequirePassword(http.HandlerFunc(handleTailscaleLoginStart)))
	mux.Handle("POST /api/tailscale/login/cancel", gate.RequirePassword(http.HandlerFunc(handleTailscaleLoginCancel)))
	mux.HandleFunc("GET /api/dev-proxy/exposes", handleListDevProxyExposes)
	mux.Handle("POST /api/dev-proxy/exposes", gate.RequirePassword(http.HandlerFunc(handleCreateDevProxyExpose)))
	mux.Handle("PUT /api/dev-proxy/exposes/{name}", gate.RequirePassword(http.HandlerFunc(handleUpdateDevProxyExpose)))
	mux.Handle("DELETE /api/dev-proxy/exposes/{name}", gate.RequirePassword(http.HandlerFunc(handleDeleteDevProxyExpose)))
	mux.Handle("POST /api/dev-proxy/reload", gate.RequirePassword(http.HandlerFunc(handleReloadDevProxy)))

	log.Printf("router-manager listening on %s (auth gate configured: %v)", addr, gate.Configured())
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleTailscaleState(w http.ResponseWriter, r *http.Request) {
	state, err := tailscale.GetState(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
