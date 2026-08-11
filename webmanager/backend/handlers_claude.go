package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"webmanager/internal/claudecode"
	"webmanager/internal/claudememory"
	"webmanager/internal/mise"
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

// claudeMiseVersionInfo reports whether the `claude-code` mise tool (global
// scope) is up to date, for an update-check banner. Only populated when
// mise is present AND claude-code is managed by mise's global config — a
// `claude` binary installed some other way (curl installer, npm -g, etc.)
// intentionally has no version-check UI, since webmanager can only drive
// upgrades through mise.
type claudeMiseVersionInfo struct {
	Current  string `json:"current"`
	Latest   string `json:"latest"`
	Outdated bool   `json:"outdated"`
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

// claudeMiseVersionResponse is GET /api/claude/mise-version's body.
// MiseVersion has no `omitempty`, so "not present" serializes as an explicit
// JSON `null` rather than a bare absence.
type claudeMiseVersionResponse struct {
	MiseVersion *claudeMiseVersionInfo `json:"miseVersion"`
}

// handleClaudeMiseVersion reports whether the `claude-code` mise tool
// (global scope) is up to date, for the update banner. Split out of
// handleClaudeStatus: `mise latest` can involve a real registry round-trip,
// so bundling it into the main status fetch made every Claude tab open wait
// on it even when the frontend has version checks turned off — this endpoint
// is only called when the frontend actually wants the answer. Same
// degrade-to-null-on-any-failure contract as the rest of this package: mise
// not found, tool not in the global list, or the latest-lookup failing are
// all normal states here, not errors.
func (s *Server) handleClaudeMiseVersion(w http.ResponseWriter, r *http.Request) {
	resp := claudeMiseVersionResponse{}

	if miseBin, ok := mise.FindBinary(s.cfg.MiseBinPath); ok {
		if tools, err := mise.ListTools(r.Context(), miseBin, ""); err == nil {
			for _, t := range tools {
				if t.Name != "claude-code" {
					continue
				}
				if latest, err := mise.GetLatestVersion(r.Context(), miseBin, "claude-code"); err == nil {
					resp.MiseVersion = &claudeMiseVersionInfo{
						Current:  t.Version,
						Latest:   latest,
						Outdated: t.Version != latest,
					}
				}
				break
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleClaudeInstall installs/updates the `claude-code` mise tool to
// whatever `mise latest claude-code` currently resolves to (no pinning an
// older version in v1) as a background job, reusing the same
// s.miseJobs.Start plumbing the mise tab's POST /api/mise/tools uses.
// Gated: this is a mutation. mise itself must already be present — claude
// can only be installed/updated through it here — but the `claude` binary
// itself is deliberately NOT required to already exist, since this
// endpoint's whole point is to work when it isn't installed yet.
func (s *Server) handleClaudeInstall(w http.ResponseWriter, r *http.Request) {
	miseBin, ok := mise.FindBinary(s.cfg.MiseBinPath)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "mise is not installed")
		return
	}

	version, err := mise.GetLatestVersion(r.Context(), miseBin, "claude-code")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "couldn't resolve latest claude-code version: "+err.Error())
		return
	}
	if err := mise.ValidateVersion(version); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	jobID := s.miseJobs.StartWithCallback(s.onMiseJobDone, miseBin, []string{"use", "-g", "-y", "claude-code@" + version})
	writeJSON(w, http.StatusOK, jobResponse{JobID: jobID})
}

// handleClaudePrefsGet reports the Claude Code tab's persisted preferences
// (open read, like every GET route not covered by a security-relevant
// exception — see webmanager/CLAUDE.md's authgate ground rule). A load
// failure just degrades to zero-value Prefs{}, matching LoadPrefs's own
// contract that a missing file is a normal state, not an error.
func (s *Server) handleClaudePrefsGet(w http.ResponseWriter, r *http.Request) {
	prefs, err := claudecode.LoadPrefs(s.cfg.ClaudePrefsPath)
	if err != nil {
		prefs = claudecode.Prefs{}
	}
	writeJSON(w, http.StatusOK, prefs)
}

// handleClaudePrefsPut saves the Claude Code tab's preferences (gated —
// this is a write). Unlike the GET side, a save failure here (disk full,
// permissions, etc) is worth surfacing as a real error rather than silently
// swallowing it.
func (s *Server) handleClaudePrefsPut(w http.ResponseWriter, r *http.Request) {
	var prefs claudecode.Prefs
	if err := json.NewDecoder(r.Body).Decode(&prefs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := claudecode.SavePrefs(s.cfg.ClaudePrefsPath, prefs); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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

// claudeLoginStartResponse is POST /api/claude/login/start's body.
type claudeLoginStartResponse struct {
	SessionID string `json:"sessionId"`
}

// handleClaudeLoginStart begins a `claude auth login` session in the
// background, proxying the CLI's interactive paste-a-code OAuth flow over
// HTTP (see claude-plan.md's "로그인(OAuth) 연계" section — this exists so
// webmanager can support setups where code-server/SSH is never opened, only
// webmanager itself). Gated: this is a live authentication flow, the same
// trust tier as Terminal, not a passive read. Only makes sense when the
// `claude` CLI is already installed.
func (s *Server) handleClaudeLoginStart(w http.ResponseWriter, r *http.Request) {
	binPath, ok := claudecode.FindBinary(s.cfg.ClaudeBinPath)
	if !ok {
		writeError(w, http.StatusNotFound, "claude CLI is not installed")
		return
	}

	id, err := s.loginMgr.Start(binPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, claudeLoginStartResponse{SessionID: id})
}

// claudeLoginStatusResponse is GET /api/claude/login/{id}'s body.
type claudeLoginStatusResponse struct {
	Running  bool     `json:"running"`
	Lines    []string `json:"lines"`
	URL      string   `json:"url"`
	ExitCode *int     `json:"exitCode"`
}

// handleClaudeLoginStatus polls session id's accumulated output/URL/exit
// state. A 404 means the session is gone (superseded by a newer Start, or
// never existed) — the frontend should treat that as "start over," not
// retry forever.
func (s *Server) handleClaudeLoginStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	lines, url, running, exitCode, ok := s.loginMgr.Status(id)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown login session")
		return
	}

	writeJSON(w, http.StatusOK, claudeLoginStatusResponse{
		Running:  running,
		Lines:    lines,
		URL:      url,
		ExitCode: exitCode,
	})
}

// claudeLoginCodeRequest is POST /api/claude/login/{id}/code's body.
type claudeLoginCodeRequest struct {
	Code string `json:"code"`
}

// handleClaudeLoginCode relays a user-pasted OAuth code back to session
// id's stdin. A real error status (not 200) is returned when the session is
// gone or already exited — unlike Cancel, this isn't meant to be
// idempotent/best-effort, the caller needs to know the code didn't go
// anywhere.
func (s *Server) handleClaudeLoginCode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req claudeLoginCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := s.loginMgr.SubmitCode(id, req.Code); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleClaudeLoginCancel kills session id's process, if it's still the
// current session. Always 200 — idempotent, matching
// claudecode.LoginManager.Cancel's own contract, since the frontend calls
// this best-effort on unmount and shouldn't get an alarming error for a
// session that's already gone.
func (s *Server) handleClaudeLoginCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_ = s.loginMgr.Cancel(id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// claudeOnboardingStatusResponse is GET /api/claude/onboarding-status's
// body.
type claudeOnboardingStatusResponse struct {
	Completed bool `json:"completed"`
}

// handleClaudeOnboardingStatus reports claudecode.HasCompletedOnboarding -
// a plain file read (no subprocess), cheap enough for
// InteractiveLoginDialog to poll every couple seconds while its wizard is
// running, and for the frontend to check once up front to decide whether
// the interactive dialog is even necessary (see that flag's own doc
// comment for why this isn't just GET /api/claude/status's auth.loggedIn).
func (s *Server) handleClaudeOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, claudeOnboardingStatusResponse{Completed: claudecode.HasCompletedOnboarding()})
}

// claudeInteractiveLoginStartResponse is
// POST /api/claude/login/interactive/start's body.
type claudeInteractiveLoginStartResponse struct {
	SessionID string `json:"sessionId"`
}

// handleClaudeInteractiveLoginStart starts the real `claude` CLI as a PTY
// session (internal/claudecode.InteractiveLoginManager) that the frontend
// then attaches to over GET /api/claude/login/interactive/{id} (a
// WebSocket, see handlers_terminal.go's handleClaudeInteractiveLoginTerminal)
// and renders with xterm.js, so the user goes through the CLI's own
// interactive onboarding wizard directly - see that manager's doc comment
// for why this exists alongside the headless flow above rather than
// replacing it outright.
func (s *Server) handleClaudeInteractiveLoginStart(w http.ResponseWriter, r *http.Request) {
	binPath, ok := claudecode.FindBinary(s.cfg.ClaudeBinPath)
	if !ok {
		writeError(w, http.StatusNotFound, "claude CLI is not installed")
		return
	}

	id, _, err := s.interactiveLoginMgr.Start(binPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, claudeInteractiveLoginStartResponse{SessionID: id})
}

// handleClaudeInteractiveLoginCancel closes session id's PTY, if it's still
// the current one. Always 200 - idempotent, matching
// claudecode.InteractiveLoginManager.Cancel's own contract, since the
// frontend calls this both as a fallback after the wizard should have
// already exited on its own and on dialog-close/unmount.
func (s *Server) handleClaudeInteractiveLoginCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_ = s.interactiveLoginMgr.Cancel(id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// claudeSessionsResponse is GET /api/claude/sessions's body. Sessions is
// never nil (see handleClaudeSessions).
type claudeSessionsResponse struct {
	Sessions []claudecode.SessionInfo `json:"sessions"`
}

// handleClaudeSessions lists every Claude Code conversation transcript
// found under CLAUDE_CONFIG_DIR/projects (see
// webmanager/.claude/session-log-plan.md) — gated like Terminal/File
// Manager/Logs since this is conversation content, not passive read like
// most of the app. A scan failure degrades to an empty list rather than a
// 5xx: a missing/unreadable projects directory just means "no sessions
// yet," not an error. An optional ?project=<absolute path> query param
// narrows the result to just that project (and its subdirectories/worktrees)
// via claudecode.FilterSessionsByProject — added for the Projects tab's own
// per-project session history section, purely additive: omitting it keeps
// the original "every session on this instance" behavior the main Claude
// tab relies on.
func (s *Server) handleClaudeSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := claudecode.ListSessions(s.cfg.ClaudeConfigDir)
	if err != nil {
		sessions = []claudecode.SessionInfo{}
	}
	if project := r.URL.Query().Get("project"); project != "" {
		sessions = claudecode.FilterSessionsByProject(sessions, project)
	}
	writeJSON(w, http.StatusOK, claudeSessionsResponse{Sessions: sessions})
}

// claudeSessionLinesResponse is GET
// /api/claude/sessions/{project}/{sessionId}'s body — raw, unparsed JSONL
// lines. Parsing/rendering happens entirely on the frontend (vendored
// conversation-schema module), see session-log-plan.md.
type claudeSessionLinesResponse struct {
	Lines   []string `json:"lines"`
	Cursor  int      `json:"cursor"`
	HasMore bool     `json:"hasMore"`
}

// handleClaudeSessionLines reads a page of raw lines from one session's
// transcript. Gated like handleClaudeSessions. An unknown project/sessionId
// (fails path validation, or just doesn't exist) is a 404, not a 500 —
// resolveSessionPath's error covers both cases identically on purpose (no
// distinction that would help an attacker enumerate valid ids).
func (s *Server) handleClaudeSessionLines(w http.ResponseWriter, r *http.Request) {
	project := r.PathValue("project")
	sessionID := r.PathValue("sessionId")

	cursor, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))

	lines, hasMore, err := claudecode.ReadSessionLines(s.cfg.ClaudeConfigDir, project, sessionID, cursor, limit)
	if err != nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	writeJSON(w, http.StatusOK, claudeSessionLinesResponse{
		Lines:   lines,
		Cursor:  cursor + len(lines),
		HasMore: hasMore,
	})
}

// handleClaudeMemory reports a project's Claude Code auto-memory
// (CLAUDE_CONFIG_DIR/projects/<slug>/memory/ — MEMORY.md index + individual
// memory files). Unlike handleClaudeSessions/handleClaudeSessionLines, this
// is ungated: memory files are curated notes (feedback/project/user
// summaries), not raw conversation content, and the same read-open
// convention handlers_projectgit.go uses applies here — `project` is
// validated against the already-known project scanner cache first, same as
// projectGitPath. A missing memory directory is not an error (see
// claudememory.Load's doc comment) — it's the normal state for a project
// Claude Code has never run against.
// handleClaudeSettingsGet returns the raw text of CLAUDE_CONFIG_DIR/
// settings.json, for the raw editor + friendly toggles in the frontend.
// Ungated (unlike git/ssh raw config, this file carries no secrets) -
// matching this repo's reads-stay-open convention.
func (s *Server) handleClaudeSettingsGet(w http.ResponseWriter, r *http.Request) {
	content, err := claudecode.ReadSettingsRaw(s.cfg.ClaudeConfigDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

// handleClaudeSettingsPut validates and writes CLAUDE_CONFIG_DIR/
// settings.json (gated - this is a write). A syntax error in the submitted
// JSON is a 400, distinguished from a genuine I/O failure (500) via
// claudecode.ErrInvalidSettingsJSON, mirroring handlePutGitConfigRaw.
func (s *Server) handleClaudeSettingsPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := claudecode.WriteSettingsRaw(s.cfg.ClaudeConfigDir, body.Content); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, claudecode.ErrInvalidSettingsJSON) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// claudeLogoutResponse is POST /api/claude/logout's body.
type claudeLogoutResponse struct {
	Message string `json:"message"`
}

// handleClaudeLogout runs `claude auth logout`, ending the authenticated
// session (gated - destructive). Any non-zero exit is surfaced as a 500 with
// the CLI's own combined output as the error message rather than swallowed,
// since the frontend needs to know the logout didn't actually happen.
func (s *Server) handleClaudeLogout(w http.ResponseWriter, r *http.Request) {
	binPath, ok := claudecode.FindBinary(s.cfg.ClaudeBinPath)
	if !ok {
		writeError(w, http.StatusNotFound, "claude CLI is not installed")
		return
	}

	message, err := claudecode.Logout(r.Context(), binPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, message)
		return
	}

	writeJSON(w, http.StatusOK, claudeLogoutResponse{Message: message})
}

func (s *Server) handleClaudeMemory(w http.ResponseWriter, r *http.Request) {
	project := r.URL.Query().Get("project")
	if project == "" {
		writeError(w, http.StatusBadRequest, "project is required")
		return
	}
	if !s.projectScanner.IsKnownPath(project) {
		writeError(w, http.StatusBadRequest, "unknown project path")
		return
	}

	mem, err := claudememory.Load(s.cfg.ClaudeConfigDir, project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, mem)
}
