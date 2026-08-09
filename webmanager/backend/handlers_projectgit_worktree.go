// Git worktree list + remove for one project — the one exception to
// handlers_projectgit.go's "everything here is a read" framing, so it gets
// its own file rather than muddying that file's doc comment. Listing stays
// ungated like every other handleProjectGit* handler; removal is a real
// mutation (git worktree remove) so it's wrapped in gate.RequirePassword in
// main.go, same convention as handlers_projects.go's delete-reclaimable/
// delete. Reuses projectGitPath/writeProjectGitErr from
// handlers_projectgit.go rather than re-deriving them.
package main

import (
	"errors"
	"net/http"

	"webmanager/internal/projectgit"
)

// handleProjectGitWorktrees lists every worktree (the project's own main
// worktree included) for path.
func (s *Server) handleProjectGitWorktrees(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	worktrees, err := projectgit.Worktrees(path)
	if err != nil {
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, worktrees)
}

// handleProjectGitWorktreeRemove removes one worktree (query param `target`)
// from path's repo. target is never trusted directly — projectgit.
// RemoveWorktree revalidates it against a freshly recomputed worktree list
// for the same project before it ever reaches exec.Command, same defense
// pattern as handleDeleteReclaimable/internal/projects.Scanner.
// DeleteReclaimable. `force=true` passes --force to git (needed when the
// worktree has uncommitted changes or is itself locked) — the frontend only
// sends this after the caller explicitly opted into a forced removal, never
// by default.
func (s *Server) handleProjectGitWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	path, ok := s.projectGitPath(w, r)
	if !ok {
		return
	}
	target := r.URL.Query().Get("target")
	if target == "" {
		writeError(w, http.StatusBadRequest, "target is required")
		return
	}
	force := r.URL.Query().Get("force") == "true"

	if err := projectgit.RemoveWorktree(path, target, force); err != nil {
		if errors.Is(err, projectgit.ErrUnknownWorktree) {
			writeError(w, http.StatusBadRequest, "unknown worktree path")
			return
		}
		writeProjectGitErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
