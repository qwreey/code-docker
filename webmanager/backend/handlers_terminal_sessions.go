package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"webmanager/internal/termsession"
)

func writeTermSessionErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, termsession.ErrSessionGone):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, termsession.ErrInvalidName):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, termsession.ErrNameTaken):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) handleListTerminalSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.termSessions.List())
}

// handleListTerminalSessionNames is the ungated, names-only counterpart of
// handleListTerminalSessions, for `attach`'s shell completion and its
// "joining"/"creating" banner (see listsessionscmd.go and attachcmd.go).
// Neither has a terminal to prompt for the password gate on at TAB time,
// and a completion that goes silent whenever the gate is on is worse than
// useless here: the default names contain a space ("세션 1"), so an
// unquoted `attach 세션 1` splits into name + start-dir and quietly creates
// a session named "세션" instead of joining the one meant. Only the names
// are exposed - no pid, cwd or timestamps - and reading them grants nothing:
// attaching to one still goes through the gated GET /api/terminal.
func (s *Server) handleListTerminalSessionNames(w http.ResponseWriter, r *http.Request) {
	sessions := s.termSessions.List()
	names := make([]string, 0, len(sessions))
	for _, info := range sessions {
		names = append(names, info.Name)
	}
	writeJSON(w, http.StatusOK, names)
}

// patchTerminalSessionRequest's fields are pointers so a request touching
// only one of pinned/name doesn't have to know the other's current value -
// e.g. a rename-only PATCH must not implicitly reset pinned to false just
// because the field was left out of that request's JSON body.
type patchTerminalSessionRequest struct {
	Pinned *bool   `json:"pinned"`
	Name   *string `json:"name"`
}

func (s *Server) handlePatchTerminalSession(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	var body patchTerminalSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Pinned == nil && body.Name == nil {
		writeError(w, http.StatusBadRequest, "request must set pinned and/or name")
		return
	}

	// Rename first, then apply pinned against the (possibly new) key - so a
	// single request setting both fields doesn't fail SetPinned by looking
	// up the old name after Rename already moved the session.
	if body.Name != nil {
		newName := strings.TrimSpace(*body.Name)
		if newName == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty")
			return
		}
		if err := s.termSessions.Rename(name, newName); err != nil {
			writeTermSessionErr(w, err)
			return
		}
		name = newName
	}

	if body.Pinned != nil {
		if err := s.termSessions.SetPinned(name, *body.Pinned); err != nil {
			writeTermSessionErr(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleGetTerminalSessionCwd backs the "open in file manager at this
// session's current directory" action — resolves the shell's live cwd via
// /proc/<pid>/cwd rather than whatever CreateOptions.Cwd it started with.
func (s *Server) handleGetTerminalSessionCwd(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	cwd, err := s.termSessions.Cwd(name)
	if err != nil {
		writeTermSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"cwd": cwd})
}

func (s *Server) handleDeleteTerminalSession(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.termSessions.Remove(name); err != nil {
		writeTermSessionErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
