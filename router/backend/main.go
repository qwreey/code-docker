// router-manager: the Go backend for router (see router/plan.md for scope).
// Mirrors webmanager's own backend pattern (stdlib net/http, no framework).
// Only serves the read-only tailscale-state endpoint so far - deliberately
// private-only for now (no host port published for this service in
// docker-compose.yml, so it's only reachable from other code-docker-internal
// containers, e.g. code-docker's nginx via its future /tailscale/ proxy
// route - see .claude/backlog/functional-router-plan.md's "tailscale
// readonly API 노출 정책").
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"router/internal/tailscale"
)

func main() {
	addr := os.Getenv("ROUTER_MANAGER_ADDR")
	if addr == "" {
		addr = ":8091"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tailscale/state", handleTailscaleState)

	log.Printf("router-manager listening on %s", addr)
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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}
