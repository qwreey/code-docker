package main

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// heartbeatBodyMaxBytes is a tighter cap than the server-wide 1 MiB default
// (server.go's limitRequestBody) — this endpoint is deliberately ungated
// (see handleSessionHeartbeat's doc comment) so it's the one route on this
// server anyone on the network can hit without a password, making a smaller
// per-route cap worth the extra line.
const heartbeatBodyMaxBytes = 4 * 1024

// uuidRe matches a standard 8-4-4-4-12 hex UUID (any version/variant byte —
// crypto.randomUUID() always produces v4, but there's no reason to reject a
// well-formed UUID from some other generator). Rejecting anything else keeps
// the id out of any future path/log-key use even though today it's just a
// map key.
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type heartbeatRequest struct {
	ID        string `json:"id"`
	Folder    string `json:"folder"`
	UserAgent string `json:"userAgent"`
}

// handleSessionHeartbeat records that a code-server tab is still open. It is
// intentionally NOT wrapped in gate.RequirePassword — code-server itself runs
// with auth: none (see root CLAUDE.md), so the code-patch script sending this
// has no credential to present in the first place. Gating it would just break
// the feature outright, not secure it. This is a documented exception to the
// rest of webmanager's reads-open/writes-gated convention: here the GET list
// below is the sensitive side (it reveals what folders are open) and this
// POST is the safe side (an id/folder/UA string with no destructive effect).
func (s *Server) handleSessionHeartbeat(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, heartbeatBodyMaxBytes)

	var body heartbeatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !uuidRe.MatchString(body.ID) {
		writeError(w, http.StatusBadRequest, "id must be a UUID")
		return
	}

	s.sessionHeartbeats.Heartbeat(body.ID, body.Folder, body.UserAgent)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.sessionHeartbeats.List())
}
