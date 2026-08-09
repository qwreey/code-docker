// DNS management routes - see router/.claude/dns-blocklist-management-plan.md.
// Every mutating route restarts the `dns` supervisord program
// (restartSupervisorProgram, defined in handlers_tailscale.go) except the
// two that provably can't have changed dnsmasq's effective config: builtin/
// ignore (acknowledges a shipped update without touching the live file) and
// a failed validation.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"router/internal/dns"
)

func restartDNS(ctx context.Context) error {
	return restartSupervisorProgram(ctx, "dns")
}

func dnsErrorStatus(err error) int {
	switch {
	case errors.Is(err, dns.ErrSourceNotFound):
		return http.StatusNotFound
	case errors.Is(err, dns.ErrSourceExists):
		return http.StatusConflict
	case errors.Is(err, dns.ErrBuiltinImmutable):
		return http.StatusBadRequest
	default:
		return http.StatusBadRequest
	}
}

// customHostsForConflictCheck feeds dns.List its current custom-hosts
// entries purely for cross-checking duplicate hostnames (see List's own doc
// comment) - a read failure here just means the conflict check runs without
// that context, not a hard error for the whole request.
func customHostsForConflictCheck() []string {
	entries, err := dns.ListCustomHosts()
	if err != nil {
		return nil
	}
	hosts := make([]string, len(entries))
	for i, e := range entries {
		hosts[i] = e.Host
	}
	return hosts
}

func handleListBlocklistSources(w http.ResponseWriter, r *http.Request) {
	result, err := dns.List(customHostsForConflictCheck())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type blocklistSourceBody struct {
	Name  string   `json:"name"`
	Hosts []string `json:"hosts"`
}

func handleCreateBlocklistSource(w http.ResponseWriter, r *http.Request) {
	var body blocklistSourceBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := dns.CreateSource(body.Name, body.Hosts); err != nil {
		writeError(w, dnsErrorStatus(err), err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func handleUpdateBlocklistSource(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Hosts []string `json:"hosts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := dns.UpdateSource(name, body.Hosts); err != nil {
		writeError(w, dnsErrorStatus(err), err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleDeleteBlocklistSource(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := dns.DeleteSource(name); err != nil {
		writeError(w, dnsErrorStatus(err), err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleBuiltinBlocklistStatus(w http.ResponseWriter, r *http.Request) {
	status, err := dns.GetBuiltinStatus()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func handleBuiltinBlocklistPull(w http.ResponseWriter, r *http.Request) {
	if err := dns.BuiltinPull(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleBuiltinBlocklistIgnore(w http.ResponseWriter, r *http.Request) {
	if err := dns.BuiltinIgnore(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleListCustomHosts(w http.ResponseWriter, r *http.Request) {
	entries, err := dns.ListCustomHosts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func handleSetCustomHosts(w http.ResponseWriter, r *http.Request) {
	var entries []dns.HostEntry
	if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := dns.SetCustomHosts(entries); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// handleDNSQuery runs a `dig`-style lookup against this container's own
// dnsmasq for debugging - a plain GET (query string, not a body) since it's
// read-only, same as every other GET route here staying outside
// gate.RequirePassword. Bounded by a short timeout since `dig` blocking on
// an unresponsive upstream shouldn't be able to hang the request forever.
func handleDNSQuery(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := dns.Query(ctx, r.URL.Query().Get("domain"), r.URL.Query().Get("type"))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, dns.ErrEmptyDomain) || errors.Is(err, dns.ErrInvalidQueryType) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func handleGetResolverConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := dns.GetResolverConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func handleSetResolverConfig(w http.ResponseWriter, r *http.Request) {
	var body dns.ResolverConfig
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := dns.SetResolverConfig(body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := restartDNS(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}
