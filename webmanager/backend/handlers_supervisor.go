package main

import (
	"errors"
	"net/http"
	"strconv"

	"webmanager/internal/supervisor"
)

// maxLogFetch caps the read-from-start request used to emulate a tail: the
// allowed RPC surface has no dedicated "log size"/"tail" call, so the
// pragmatic approach is offset=0 with a generous length, then slicing the
// tail client-side.
const maxLogFetch = 10 * 1024 * 1024

// processResponse is ProcessInfo enriched with this program's metadata (see
// config/supervisor-metadata.default.yaml / internal/supervisor.LoadMetadata)
// so the frontend can disable start/stop/restart/logs controls and show an
// explanatory note without a second round-trip.
type processResponse struct {
	supervisor.ProcessInfo
	Label          string `json:"label,omitempty"`
	Note           string `json:"note,omitempty"`
	DisableStart   bool   `json:"disableStart"`
	DisableStop    bool   `json:"disableStop"`
	DisableRestart bool   `json:"disableRestart"`
	DisableLogs    bool   `json:"disableLogs"`
}

func (s *Server) handleListProcesses(w http.ResponseWriter, r *http.Request) {
	procs, err := s.sup.GetAllProcessInfo(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	meta, err := supervisor.LoadMetadata(s.cfg.SupervisorMetadataDefaultPath, s.cfg.SupervisorMetadataOverridePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	out := make([]processResponse, 0, len(procs))
	for _, p := range procs {
		m := meta[p.Name]
		out = append(out, processResponse{
			ProcessInfo:    p,
			Label:          m.Label,
			Note:           m.Note,
			DisableStart:   m.DisableStart,
			DisableStop:    m.DisableStop,
			DisableRestart: m.DisableRestart,
			DisableLogs:    m.DisableLogs,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// statusForFault maps supervisord's own fault codes (supervisor/xmlrpc.py)
// to HTTP status: BAD_NAME means the process doesn't exist, ALREADY_STARTED/
// NOT_RUNNING are conflicts with current state, anything else is a genuine
// upstream failure.
func statusForFault(f *supervisor.Fault) int {
	switch f.Code {
	case 10: // BAD_NAME
		return http.StatusNotFound
	case 60, 70: // ALREADY_STARTED, NOT_RUNNING
		return http.StatusConflict
	default:
		return http.StatusBadGateway
	}
}

func writeSupervisorErr(w http.ResponseWriter, err error) {
	var f *supervisor.Fault
	if errors.As(err, &f) {
		writeError(w, statusForFault(f), f.Message)
		return
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

func (s *Server) handleStartProcess(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.sup.StartProcess(r.Context(), name); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleStopProcess(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.sup.StopProcess(r.Context(), name); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRestartProcess(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ctx := r.Context()

	if err := s.sup.StopProcess(ctx, name); err != nil {
		var f *supervisor.Fault
		if !errors.As(err, &f) {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if f.Code != 70 { // NOT_RUNNING is expected when already stopped
			writeError(w, statusForFault(f), f.Message)
			return
		}
	}

	if err := s.sup.StartProcess(ctx, name); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleProcessLog(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	stream := r.URL.Query().Get("stream")
	if stream == "" {
		stream = "stdout"
	}
	if stream != "stdout" && stream != "stderr" {
		writeError(w, http.StatusBadRequest, "stream must be stdout or stderr")
		return
	}

	tail := 10000
	if v := r.URL.Query().Get("tail"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "tail must be a positive integer")
			return
		}
		tail = n
	}

	var (
		content string
		err     error
	)
	if stream == "stdout" {
		content, err = s.sup.ReadProcessStdoutLog(r.Context(), name, 0, maxLogFetch)
	} else {
		content, err = s.sup.ReadProcessStderrLog(r.Context(), name, 0, maxLogFetch)
	}
	if err != nil {
		writeSupervisorErr(w, err)
		return
	}

	if len(content) > tail {
		content = content[len(content)-tail:]
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": content})
}
