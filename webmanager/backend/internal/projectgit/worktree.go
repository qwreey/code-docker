package projectgit

import (
	"errors"
	"strings"
)

// WorktreeInfo is one entry from `git worktree list --porcelain` — the
// repo's main worktree (Path == the project's own root) is always included
// alongside any linked ones.
type WorktreeInfo struct {
	Path           string `json:"path"`
	Head           string `json:"head,omitempty"`
	Branch         string `json:"branch,omitempty"`
	Detached       bool   `json:"detached"`
	Bare           bool   `json:"bare"`
	Locked         bool   `json:"locked"`
	LockReason     string `json:"lockReason,omitempty"`
	Prunable       bool   `json:"prunable"`
	PrunableReason string `json:"prunableReason,omitempty"`
}

// Worktrees returns every worktree linked to path (the main worktree
// included), via `git worktree list --porcelain`.
func Worktrees(path string) ([]WorktreeInfo, error) {
	if !IsGitRepo(path) {
		return nil, ErrNotGitRepo
	}
	out, err := runGit(path, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	return parseWorktreePorcelain(string(out)), nil
}

// ErrUnknownWorktree is returned by RemoveWorktree when worktreePath doesn't
// exactly match the Path of any entry from a freshly recomputed Worktrees
// list for that same project — see RemoveWorktree's doc comment.
var ErrUnknownWorktree = errors.New("path is not a worktree of this project")

// RemoveWorktree removes worktreePath from projectPath's repo via `git
// worktree remove`. worktreePath is never trusted directly from a caller —
// it must exactly match the Path of one entry from a freshly-computed
// Worktrees(projectPath), same defense pattern as
// internal/projects.Scanner.DeleteReclaimable revalidating a target against
// its own freshly-scanned cache rather than trusting a client-supplied path.
// The path is passed as its own exec.Command argument (never string-
// concatenated) with a leading "--" so it can never be misparsed as a flag,
// same defense-in-depth CommitDiff's hashRe validation exists for. force
// adds --force (needed when the worktree has uncommitted changes, or is
// itself locked) — callers must only set this when the caller explicitly
// asked for a forced removal, not by default.
func RemoveWorktree(projectPath, worktreePath string, force bool) error {
	worktrees, err := Worktrees(projectPath)
	if err != nil {
		return err
	}
	valid := false
	for _, wt := range worktrees {
		if wt.Path == worktreePath {
			valid = true
			break
		}
	}
	if !valid {
		return ErrUnknownWorktree
	}

	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, "--", worktreePath)
	_, err = runGit(projectPath, args...)
	return err
}

// parseWorktreePorcelain parses `git worktree list --porcelain` output into
// one WorktreeInfo per blank-line-delimited record, mirroring how
// parseBranchLine/classifyStatusLine in parse.go classify fixed-vocabulary
// git output line by line. Each record's lines are a fixed vocabulary:
// "worktree <path>" (always first, starts a new record), "HEAD <sha>",
// "branch <ref>", a bare "detached" tag (mutually exclusive with branch), a
// bare "bare" tag (a bare repo's main worktree has no HEAD/branch line at
// all), and optional "locked [<reason>]"/"prunable [<reason>]" tags. Order
// within a record beyond "worktree" starting it is not depended on.
func parseWorktreePorcelain(output string) []WorktreeInfo {
	worktrees := make([]WorktreeInfo, 0)
	var cur *WorktreeInfo

	flush := func() {
		if cur != nil {
			worktrees = append(worktrees, *cur)
			cur = nil
		}
	}

	for _, line := range strings.Split(strings.TrimRight(output, "\n"), "\n") {
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur = &WorktreeInfo{Path: strings.TrimPrefix(line, "worktree ")}
		case cur == nil:
			continue // malformed/unexpected line before any "worktree" header — skip
		case strings.HasPrefix(line, "HEAD "):
			cur.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
		case line == "detached":
			cur.Detached = true
		case line == "bare":
			cur.Bare = true
		case line == "locked" || strings.HasPrefix(line, "locked "):
			cur.Locked = true
			cur.LockReason = strings.TrimSpace(strings.TrimPrefix(line, "locked"))
		case line == "prunable" || strings.HasPrefix(line, "prunable "):
			cur.Prunable = true
			cur.PrunableReason = strings.TrimSpace(strings.TrimPrefix(line, "prunable"))
		}
	}
	flush()
	return worktrees
}
