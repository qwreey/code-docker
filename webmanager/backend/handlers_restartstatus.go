package main

import (
	"context"
	"log"
	"net/http"

	"webmanager/internal/restartstatus"
)

// currentCodeServerProc fetches code-server's live (pid, start) from
// supervisord (the program is named "code-server" in
// config/supervisord.default.conf). ok is false if supervisord can't be
// reached or the process isn't known/running (Pid is 0 while stopped) —
// either way, "we can't confirm it's still the same instance", which
// markRestartDirty/handleRestartStatus both treat as "not dirty" rather than
// risking a stuck-forever banner.
func (s *Server) currentCodeServerProc(ctx context.Context) (pid int64, start int64, ok bool) {
	procs, err := s.sup.GetAllProcessInfo(ctx)
	if err != nil {
		return 0, 0, false
	}
	for _, p := range procs {
		if p.Name == "code-server" {
			return p.Pid, p.Start, p.Pid != 0
		}
	}
	return 0, 0, false
}

// markRestartDirty records the current code-server (pid, start) as "dirty
// since" — called after a mise tool install/uninstall, a Claude Code
// install/update, or a code-server extension install/uninstall completes
// successfully. Deliberately takes no context from the triggering request:
// mise/claude installs run as background jobs (see
// mise.JobStore.StartWithCallback) whose completion callback fires well
// after the original request's context has already been canceled. A failure
// to determine the current process info or to persist the state is logged,
// not surfaced — this is a best-effort UX nicety, not something that should
// ever fail the install/uninstall itself.
func (s *Server) markRestartDirty() {
	pid, start, ok := s.currentCodeServerProc(context.Background())
	if !ok {
		return
	}
	state := restartstatus.State{DirtySincePid: pid, DirtySinceStart: start}
	if err := restartstatus.Save(s.cfg.RestartStatusPath, state); err != nil {
		log.Printf("markRestartDirty: %v", err)
	}
}

// onMiseJobDone is the mise.JobStore completion callback shared by
// POST /api/mise/tools, DELETE /api/mise/tools, and POST /api/claude/install
// (which reuses the same JobStore — see handlers_claude.go). Only a
// successful run marks a restart as needed; a failed install/uninstall
// didn't actually change anything code-server would need to pick up.
func (s *Server) onMiseJobDone(exitCode int) {
	if exitCode == 0 {
		s.markRestartDirty()
	}
}

// handleRestartStatus reports whether code-server still needs a restart to
// pick up a completed mise/extension/Claude Code install or uninstall — see
// internal/restartstatus's doc comment for the self-clearing comparison
// this performs. Not gated: a boolean with no sensitive content, same tier
// as the other open reads.
func (s *Server) handleRestartStatus(w http.ResponseWriter, r *http.Request) {
	state, err := restartstatus.Load(s.cfg.RestartStatusPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	dirty := false
	if state.DirtySincePid != 0 {
		if pid, start, ok := s.currentCodeServerProc(r.Context()); ok && pid == state.DirtySincePid && start == state.DirtySinceStart {
			dirty = true
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"dirty": dirty})
}
