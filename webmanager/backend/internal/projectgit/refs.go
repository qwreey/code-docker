package projectgit

import "strings"

// Remote is one git remote, fetch/push URLs merged into a single entry
// (deduped when identical, which is the overwhelming common case — `git
// remote -v` otherwise reports a separate "(fetch)"/"(push)" line per
// remote).
type Remote struct {
	Name     string `json:"name"`
	FetchURL string `json:"fetchUrl"`
	PushURL  string `json:"pushUrl"`
}

// Remotes returns every remote configured for path, via `git remote -v`. A
// repo with no remotes yields an empty, non-error slice.
func Remotes(path string) ([]Remote, error) {
	if !IsGitRepo(path) {
		return nil, ErrNotGitRepo
	}
	out, err := runGit(path, "remote", "-v")
	if err != nil {
		return nil, err
	}

	order := make([]string, 0)
	byName := make(map[string]*Remote)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue // malformed line — skip rather than fail the whole list
		}
		name, url, kind := fields[0], fields[1], fields[2]
		r, ok := byName[name]
		if !ok {
			r = &Remote{Name: name}
			byName[name] = r
			order = append(order, name)
		}
		switch kind {
		case "(fetch)":
			r.FetchURL = url
		case "(push)":
			r.PushURL = url
		}
	}

	remotes := make([]Remote, 0, len(order))
	for _, name := range order {
		remotes = append(remotes, *byName[name])
	}
	return remotes, nil
}

// Branch is one local or remote-tracking branch.
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	Remote  bool   `json:"remote"`
}

// Branches returns every local and remote-tracking branch for path, via
// `git branch -a`. Symbolic refs (a detached-HEAD pseudo-entry, a remote's
// "<remote>/HEAD" pointer to its default branch) are filtered out — neither
// is a real branch a caller would want listed.
func Branches(path string) ([]Branch, error) {
	if !IsGitRepo(path) {
		return nil, ErrNotGitRepo
	}
	out, err := runGit(path, "branch", "-a", "--format=%(refname)|%(refname:short)|%(HEAD)")
	if err != nil {
		return nil, err
	}

	branches := make([]Branch, 0)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			continue
		}
		refname, short, headMark := parts[0], parts[1], parts[2]

		isLocal := strings.HasPrefix(refname, "refs/heads/")
		isRemote := strings.HasPrefix(refname, "refs/remotes/")
		if !isLocal && !isRemote {
			continue // e.g. "(HEAD detached at ...)"
		}
		if isRemote && strings.HasSuffix(refname, "/HEAD") {
			continue // symbolic pointer to the remote's default branch, not a real branch
		}

		branches = append(branches, Branch{
			Name:    short,
			Current: headMark == "*",
			Remote:  isRemote,
		})
	}
	return branches, nil
}

// Tag is one tag. Date/CommitHash are best-effort — populated from the same
// cheap `git tag --format` call, empty when unavailable rather than causing
// a separate lookup.
type Tag struct {
	Name string `json:"name"`
	Date string `json:"date,omitempty"`
	Hash string `json:"hash,omitempty"`
}

// Tags returns every tag for path, via `git tag -l --format=...`. A repo
// with no tags yields an empty, non-error slice.
func Tags(path string) ([]Tag, error) {
	if !IsGitRepo(path) {
		return nil, ErrNotGitRepo
	}
	out, err := runGit(path, "tag", "-l", "--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname)")
	if err != nil {
		return nil, err
	}

	tags := make([]Tag, 0)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		t := Tag{Name: parts[0]}
		if len(parts) > 1 {
			t.Date = parts[1]
		}
		if len(parts) > 2 {
			t.Hash = parts[2]
		}
		tags = append(tags, t)
	}
	return tags, nil
}
