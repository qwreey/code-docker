package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"webmanager/internal/supervisor"
	"webmanager/internal/tailscale"
)

// tailscaleForwardProgram is the supervisord program name that reads
// TailscaleConfigPath once at startup (config/tailscale-forward.default.sh
// in the repo root) — every mutation here must restart it for the change to
// take effect, the same effect as the bin/forward-reload script.
const tailscaleForwardProgram = "tailscale-forward"

// restartTailscaleForward stops (tolerating NOT_RUNNING) then starts
// tailscale-forward, mirroring handleRestartProcess in handlers_supervisor.go.
func (s *Server) restartTailscaleForward(ctx context.Context) error {
	if err := s.sup.StopProcess(ctx, tailscaleForwardProgram); err != nil {
		var f *supervisor.Fault
		if !errors.As(err, &f) || f.Code != 70 { // NOT_RUNNING is expected when already stopped
			return err
		}
	}
	return s.sup.StartProcess(ctx, tailscaleForwardProgram)
}

func (s *Server) handleGetTailscaleConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := tailscale.GetGlobalConfig(s.cfg.TailscaleConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handlePutTailscaleConfig(w http.ResponseWriter, r *http.Request) {
	var body tailscale.GlobalConfig
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := tailscale.SetGlobalConfig(s.cfg.TailscaleConfigPath, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.restartTailscaleForward(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleListTailscaleForwards(w http.ResponseWriter, r *http.Request) {
	forwards, err := tailscale.ListForwards(s.cfg.TailscaleConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, forwards)
}

func (s *Server) handleAddTailscaleForward(w http.ResponseWriter, r *http.Request) {
	var body tailscale.Forward
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	forward, err := tailscale.AddForward(s.cfg.TailscaleConfigPath, body)
	if err != nil {
		if errors.Is(err, tailscale.ErrForwardExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.restartTailscaleForward(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, forward)
}

func (s *Server) handleDeleteTailscaleForward(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := tailscale.DeleteForward(s.cfg.TailscaleConfigPath, name); err != nil {
		if errors.Is(err, tailscale.ErrForwardNotFound) {
			writeError(w, http.StatusNotFound, "forward not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.restartTailscaleForward(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListTailscalePublish(w http.ResponseWriter, r *http.Request) {
	publish, err := tailscale.ListPublish(s.cfg.TailscaleConfigPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, publish)
}

func (s *Server) handleAddTailscalePublish(w http.ResponseWriter, r *http.Request) {
	var body tailscale.Publish
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	publish, err := tailscale.AddPublish(s.cfg.TailscaleConfigPath, body)
	if err != nil {
		if errors.Is(err, tailscale.ErrPublishExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.restartTailscaleForward(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, publish)
}

// tailscaleStatusResponse is GET /api/tailscale/status's body. Status is a
// plain pointer with no `omitempty` so it serializes as an explicit JSON
// `null` when Available is false, matching the read-only status contract
// agreed with the frontend.
type tailscaleStatusResponse struct {
	Available bool              `json:"available"`
	Status    *tailscale.Status `json:"status,omitempty"`
}

// handleTailscaleStatus reports live tailnet status via `tailscale status
// --json`, mirroring handleClaudeStatus's degrade-to-unavailable pattern:
// `tailscale` missing from PATH, a stopped daemon, or a parse failure are
// all normal states here, not errors — never a non-200 for any of them.
func (s *Server) handleTailscaleStatus(w http.ResponseWriter, r *http.Request) {
	binPath, ok := tailscale.FindBinary(s.cfg.TailscaleBinPath)
	if !ok {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Available: false})
		return
	}

	status, err := tailscale.GetStatus(r.Context(), binPath)
	if err != nil {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Available: false})
		return
	}

	writeJSON(w, http.StatusOK, tailscaleStatusResponse{Available: true, Status: &status})
}

// handleTailscaleLoginStart triggers an on-demand `tailscale up`, for the
// "로그인 시도하기" retry button in the Tailscale tab - the automatic attempt
// tailscale-service.default.sh makes on first boot only fires once ever (see
// LOGIN_ATTEMPTED_MARKER there), so this is how a later retry happens
// without needing a container restart. Gated like the other tailscale
// mutations: it changes live daemon state, not a passive read.
//
// Deliberately checks current status first and skips starting a second
// process if a login is already pending (AuthURL set) - the frontend should
// just keep polling the existing GET /api/tailscale/status instead, which
// already reports BackendState/AuthURL without any stdout scraping.
func (s *Server) handleTailscaleLoginStart(w http.ResponseWriter, r *http.Request) {
	binPath, ok := tailscale.FindBinary(s.cfg.TailscaleBinPath)
	if !ok {
		writeError(w, http.StatusNotFound, "tailscale is not installed")
		return
	}

	if status, err := tailscale.GetStatus(r.Context(), binPath); err == nil {
		if status.BackendState == "Running" {
			writeError(w, http.StatusConflict, "already logged in")
			return
		}
		if status.AuthURL != "" {
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
	}

	if err := s.tailscaleLogin.Start(binPath, s.cfg.TailscaleLoginServer); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleTailscaleLoginCancel kills an in-flight on-demand login attempt, if
// any. Always 200 - idempotent, matching tailscale.LoginManager.Cancel's
// contract.
func (s *Server) handleTailscaleLoginCancel(w http.ResponseWriter, r *http.Request) {
	_ = s.tailscaleLogin.Cancel()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteTailscalePublish(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := tailscale.DeletePublish(s.cfg.TailscaleConfigPath, name); err != nil {
		if errors.Is(err, tailscale.ErrPublishNotFound) {
			writeError(w, http.StatusNotFound, "publish not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.restartTailscaleForward(r.Context()); err != nil {
		writeSupervisorErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
