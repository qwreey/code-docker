// netgate outbound CIDR / inbound port-forward CRUD (see
// internal/netgate). Unlike tailscale/tinyauth, no supervisord restart is
// needed after a write - netgate-firewall.default.sh's own loop re-reads
// LiveConfigPath every 30s (see firewall.default.sh), so a change here
// just needs to land on disk.
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"router/internal/netgate"
)

func handleListNetgateOutbound(w http.ResponseWriter, r *http.Request) {
	rules, err := netgate.ListOutbound(netgate.LiveConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func handleReplaceNetgateOutbound(w http.ResponseWriter, r *http.Request) {
	var body []netgate.OutboundRule
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rules, err := netgate.ReplaceOutbound(netgate.LiveConfigPath, body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func handleListNetgateForwards(w http.ResponseWriter, r *http.Request) {
	forwards, err := netgate.ListForwards(netgate.LiveConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, forwards)
}

func handleAddNetgateForward(w http.ResponseWriter, r *http.Request) {
	var body netgate.Forward
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	forward, err := netgate.AddForward(netgate.LiveConfigPath, body)
	if err != nil {
		if errors.Is(err, netgate.ErrForwardExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, forward)
}

func handleDeleteNetgateForward(w http.ResponseWriter, r *http.Request) {
	hostPort, err := strconv.Atoi(r.PathValue("hostPort"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "hostPort must be a number")
		return
	}
	if err := netgate.DeleteForward(netgate.LiveConfigPath, hostPort); err != nil {
		if errors.Is(err, netgate.ErrForwardNotFound) {
			writeError(w, http.StatusNotFound, "forward not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
