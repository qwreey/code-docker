package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"syscall"

	"webmanager/internal/procinfo"
)

func (s *Server) handleListSystemProcesses(w http.ResponseWriter, r *http.Request) {
	procs, err := s.procSampler.ListProcesses(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Readable without the gate, but command lines carry secrets often
	// enough (procinfo.RedactCmdline) that a locked gate masks them. A copy,
	// in case the sampler hands out a slice it keeps.
	if s.gate.Configured() && !s.gate.Unlocked(r) {
		masked := make([]procinfo.ProcessInfo, len(procs))
		for i, p := range procs {
			p.Cmdline = procinfo.RedactCmdline(p.Cmdline)
			masked[i] = p
		}
		procs = masked
	}
	writeJSON(w, http.StatusOK, procs)
}

func (s *Server) handleListPorts(w http.ResponseWriter, r *http.Request) {
	ports, err := procinfo.ListPorts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ports)
}

func (s *Server) handleSignalProcess(w http.ResponseWriter, r *http.Request) {
	pid, err := strconv.Atoi(r.PathValue("pid"))
	if err != nil || pid <= 0 {
		writeError(w, http.StatusBadRequest, "pid must be a positive integer")
		return
	}

	var body struct {
		Signal string `json:"signal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var sig syscall.Signal
	switch body.Signal {
	case "TERM":
		sig = syscall.SIGTERM
	case "KILL":
		sig = syscall.SIGKILL
	default:
		writeError(w, http.StatusBadRequest, "signal must be TERM or KILL")
		return
	}

	if err := syscall.Kill(pid, sig); err != nil {
		switch {
		case errors.Is(err, syscall.ESRCH):
			writeError(w, http.StatusNotFound, "no such process")
		case errors.Is(err, syscall.EPERM):
			writeError(w, http.StatusForbidden, "permission denied")
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
