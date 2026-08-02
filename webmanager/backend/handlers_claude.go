package main

import (
	"net/http"

	"webmanager/internal/claudecode"
)

// claudeStatusResponse is GET /api/claude/status's body. Auth/Stats are
// plain pointers with no `omitempty` so a nil value serializes as an
// explicit JSON `null` (not merely omitted) when installed is true but that
// sub-fetch degraded — matching claude-plan.md's M1 API contract, which the
// frontend is being built against concurrently. When Installed is false,
// both stay nil/null too, which the contract also allows.
type claudeStatusResponse struct {
	Installed bool              `json:"installed"`
	Auth      *claudecode.Auth  `json:"auth"`
	Stats     *claudecode.Stats `json:"stats"`
}

// handleClaudeStatus reports whether the `claude` CLI is available and, if
// so, its login/subscription state and local usage stats. This is a
// quick-overview, read-only endpoint (M1) — every sub-fetch degrades
// independently to a null field rather than failing the request, since
// "claude not installed", "not logged in", or "no stats cache yet" are all
// normal states, not errors. Only a genuinely unexpected failure outside all
// of that would justify a non-200, which isn't expected to happen here in
// practice.
func (s *Server) handleClaudeStatus(w http.ResponseWriter, r *http.Request) {
	binPath, ok := claudecode.FindBinary(s.cfg.ClaudeBinPath)
	if !ok {
		writeJSON(w, http.StatusOK, claudeStatusResponse{Installed: false})
		return
	}

	resp := claudeStatusResponse{Installed: true}

	if auth, err := claudecode.GetAuthStatus(r.Context(), binPath); err == nil {
		resp.Auth = &auth
	}

	if stats, err := claudecode.LoadStats(s.cfg.ClaudeConfigDir); err == nil {
		resp.Stats = &stats
	}

	writeJSON(w, http.StatusOK, resp)
}

// claudePluginsResponse is GET /api/claude/plugins's body. Plugins is never
// nil — see handleClaudePlugins.
type claudePluginsResponse struct {
	Plugins []claudecode.Plugin `json:"plugins"`
}

// handleClaudePlugins reports the installed Claude Code skills/plugins
// (M3, read-only). Like handleClaudeStatus, this degrades to an empty list
// rather than an HTTP error for every failure mode (claude not installed,
// command error, timeout, unparseable output) — the frontend already knows
// whether Claude is installed at all from /api/claude/status and only
// renders this section when that's true, so this endpoint just needs to
// never fail the whole response.
func (s *Server) handleClaudePlugins(w http.ResponseWriter, r *http.Request) {
	resp := claudePluginsResponse{Plugins: []claudecode.Plugin{}}

	if binPath, ok := claudecode.FindBinary(s.cfg.ClaudeBinPath); ok {
		if plugins := claudecode.ListPlugins(r.Context(), binPath); plugins != nil {
			resp.Plugins = plugins
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
