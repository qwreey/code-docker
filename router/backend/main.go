// router-manager: the Go backend for router (see router/plan.md for scope).
// Mirrors webmanager's own backend pattern (stdlib net/http, no framework).
// Structurally private by default: binds a unix socket
// (ROUTER_MANAGER_SOCK, default /run/router-manager.sock) rather than a TCP
// port, so there is no address for another container to reach at all -
// only router's own nginx (same container/netns) proxies to it. See
// router/.claude/router-nginx-hardening-plan.md for why the previous
// ":8091 on all interfaces, reachable directly from code-docker" setup was
// a real gap despite doc comments describing it as "private by design".
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"

	"code-docker/envmigrate"

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
	// CLI helper mode: `router-manager --env-migrate` reconciles a piped-in
	// .env.router against this image's current example-env.router and exits
	// - never starts the server. See envmigratecmd.go's doc comment.
	if len(os.Args) > 1 && os.Args[1] == "--env-migrate" {
		os.Exit(envMigrateCmd())
	}

	// Env-version mismatch check, mirrors webmanager/backend/main.go's own
	// check - a stale .env.router mostly still works fine (every key has a
	// sane default), so this is a warning, not a startup failure. An
	// unreadable template just means the check is skipped, not a crash.
	envTemplatePath := os.Getenv("ROUTER_ENV_TEMPLATE_PATH")
	if envTemplatePath == "" {
		envTemplatePath = "/etc/code-docker/example-env.router"
	}
	if data, err := os.ReadFile(envTemplatePath); err != nil {
		log.Printf("main: couldn't read env template at %s for version check: %v", envTemplatePath, err)
	} else {
		envTemplateVersion := envmigrate.ParseVersion(string(data), envMigrateOpts.VersionKey)
		envVersion := os.Getenv("ROUTER_ENV_VERSION")
		if envTemplateVersion != "" && envTemplateVersion != envVersion {
			log.Printf("main: ⚠️ .env.router version is %q but this image's example-env.router is at %q - run `router-manager --env-migrate` to pick up added/changed settings", envVersion, envTemplateVersion)
		}
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
	authStorePath := os.Getenv("ROUTER_MANAGER_AUTH_STORE_PATH")
	if authStorePath == "" {
		authStorePath = "/var/lib/code-docker-router/auth-hash.json"
	}
	gate = authgate.New(authPasswordHash, authStorePath)

	staticDir := os.Getenv("ROUTER_MANAGER_STATIC_DIR")
	if staticDir == "" {
		staticDir = "./static"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/unlock", handleAuthUnlock)
	mux.HandleFunc("GET /api/auth/status", handleAuthStatus)
	mux.HandleFunc("POST /api/auth/setup", handleAuthSetup)
	mux.HandleFunc("POST /api/auth/change", handleAuthChange)

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

	mux.HandleFunc("GET /api/app-routes/apps", handleListAppRoutes)
	mux.Handle("POST /api/app-routes/apps", gate.RequirePassword(http.HandlerFunc(handleCreateAppRoute)))
	mux.Handle("PUT /api/app-routes/apps/{name}", gate.RequirePassword(http.HandlerFunc(handleUpdateAppRoute)))
	mux.Handle("DELETE /api/app-routes/apps/{name}", gate.RequirePassword(http.HandlerFunc(handleDeleteAppRoute)))
	mux.Handle("POST /api/app-routes/reload", gate.RequirePassword(http.HandlerFunc(handleReloadAppRoutes)))

	mux.HandleFunc("GET /api/tinyauth/users", handleListTinyauthUsers)
	mux.Handle("POST /api/tinyauth/users", gate.RequirePassword(http.HandlerFunc(handleAddTinyauthUser)))
	mux.Handle("DELETE /api/tinyauth/users/{name}", gate.RequirePassword(http.HandlerFunc(handleDeleteTinyauthUser)))

	// Everything else falls through to the built SPA (AppRoutes/DevProxy/
	// Tailscale/설정 tabs) - replaces the old standalone password-only page
	// (handlers_ui.go), whose setup/change functionality is now
	// RouterAuthPanel inside the SPA itself.
	mux.Handle("GET /", staticHandler(staticDir))

	listener, err := listen()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("router-manager listening on %s (auth gate configured: %v, source: %s)", listener.Addr(), gate.Configured(), gate.Source())
	if err := http.Serve(listener, mux); err != nil {
		log.Fatal(err)
	}
}

// listen binds a unix socket by default (ROUTER_MANAGER_SOCK, default
// /run/router-manager.sock). Setting ROUTER_MANAGER_ADDR is an explicit
// opt-in to bind TCP instead - useful for local development outside a
// container, where nothing else in router's own netns would otherwise
// reach a unix socket anyway.
func listen() (net.Listener, error) {
	if addr := os.Getenv("ROUTER_MANAGER_ADDR"); addr != "" {
		return net.Listen("tcp", addr)
	}
	sockPath := os.Getenv("ROUTER_MANAGER_SOCK")
	if sockPath == "" {
		sockPath = "/run/router-manager.sock"
	}
	// /run is container-local tmpfs, but that only guarantees a clean slate
	// across a full container recreate, not every restart - `docker compose
	// restart` (or supervisord restarting just this program after a
	// non-graceful SIGTERM, which skips Go's normal listener-close cleanup)
	// keeps the same tmpfs mount, so a previous run's socket inode can still
	// be sitting at this path. Unlinking it first is the standard unix-socket
	// server idiom; there's only ever one router-manager process (supervisord
	// enforces that), so removing a leftover path here can't race a still-live
	// listener. Confirmed live: without this, a restart reliably hit "bind:
	// address already in use" and router-manager crash-looped into FATAL.
	_ = os.Remove(sockPath)
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, err
	}
	// 0o660: readable/writable by the socket's owner and group (router's
	// own nginx runs in the same container, typically as root like every
	// other supervisord program here - see router/config/supervisord.d/).
	if err := os.Chmod(sockPath, 0o660); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
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
