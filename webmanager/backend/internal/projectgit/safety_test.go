package projectgit

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	full := append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always"}, args...)
	if out, err := exec.Command("git", full...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

// isolateGitConfig keeps the machine's own system/global git config out of
// a test.
func isolateGitConfig(t *testing.T) {
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "gitconfig"))
}

// Every way a repository's config can make one of this package's reads run
// a command, planted at once. A plain `git status`/`git diff` first shows
// they are live; then every exported read must run none of them.
func TestReadsRunNothingTheRepoNames(t *testing.T) {
	isolateGitConfig(t)
	root := t.TempDir()
	hits := filepath.Join(root, "hits")
	if err := os.Mkdir(hits, 0o755); err != nil {
		t.Fatal(err)
	}
	mark := filepath.Join(root, "mark")
	writeFile(t, mark, "#!/bin/sh\ntouch '"+hits+"'/\"$1\"\n", 0o755)
	gpgMark := filepath.Join(root, "gpg-mark")
	writeFile(t, gpgMark, "#!/bin/sh\ntouch '"+hits+"'/gpg\nexit 1\n", 0o755)
	ran := func() []string {
		entries, _ := os.ReadDir(hits)
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
			os.Remove(filepath.Join(hits, e.Name()))
		}
		return names
	}

	sub := filepath.Join(root, "sub")
	gitT(t, root, "init", "-q", "sub")
	writeFile(t, filepath.Join(sub, "s"), "s\n", 0o644)
	gitT(t, sub, "add", "s")
	gitT(t, sub, "commit", "-qm", "s")

	repo := filepath.Join(root, "repo")
	gitT(t, root, "init", "-q", "repo")
	writeFile(t, filepath.Join(repo, "f.txt"), "a\n", 0o644)
	writeFile(t, filepath.Join(repo, "x.a"), "z\n", 0o644)
	writeFile(t, filepath.Join(repo, "x.w"), "z\n", 0o644)
	writeFile(t, filepath.Join(repo, ".gitattributes"), "*.txt diff=tc filter=ft\n", 0o644)
	gitT(t, repo, "add", ".")
	gitT(t, repo, "commit", "-qm", "one")
	writeFile(t, filepath.Join(repo, "f.txt"), "a\nb\n", 0o644)
	gitT(t, repo, "add", "f.txt")
	gitT(t, repo, "submodule", "add", "-q", sub, "sub")
	gitT(t, repo, "commit", "-qm", "two")
	wt := filepath.Join(root, "wt")
	gitT(t, repo, "worktree", "add", "-q", wt, "HEAD")
	// A commit carrying a signature, so log.showSignature has one to check.
	raw, err := exec.Command("git", "-C", repo, "cat-file", "commit", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	header, body, _ := strings.Cut(string(raw), "\n\n")
	signed := header + "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\n" + body
	cmd := exec.Command("git", "-C", repo, "hash-object", "-t", "commit", "-w", "--stdin")
	cmd.Stdin = strings.NewReader(signed)
	signedHash, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	gitT(t, repo, "update-ref", "HEAD", strings.TrimSpace(string(signedHash)))

	for _, kv := range [][2]string{
		{"core.fsmonitor", mark + " fsmonitor"},
		{"diff.external", mark + " diff-external"},
		{"diff.tc.textconv", mark + " textconv"},
		{"diff.tc.command", mark + " diff-command"},
		{"filter.ft.clean", mark + " filter-gitattributes"},
		{"filter.ft.process", mark + " filter-process"},
		{"filter.fa.clean", mark + " filter-info-attributes"},
		{"filter.fa.required", "true"},
		{"diff.submodule", "diff"},
		{"status.submoduleSummary", "true"},
		{"log.showSignature", "true"},
		{"gpg.program", gpgMark},
		{"extensions.worktreeConfig", "true"},
	} {
		gitT(t, repo, "config", kv[0], kv[1])
	}
	gitT(t, sub, "config", "core.fsmonitor", mark+" submodule-fsmonitor")
	gitT(t, filepath.Join(repo, "sub"), "config", "core.fsmonitor", mark+" submodule-fsmonitor")
	gitT(t, wt, "config", "--worktree", "filter.fw.clean", mark+" worktree-filter")
	writeFile(t, filepath.Join(repo, ".git", "info", "attributes"), "*.a filter=fa\n*.w filter=fw\n", 0o644)
	for _, hook := range []string{"post-index-change", "reference-transaction"} {
		writeFile(t, filepath.Join(repo, ".git", "hooks", hook), "#!/bin/sh\ntouch '"+hits+"'/hook-"+hook+"\n", 0o755)
	}
	// Same-size edits with an old mtime: status has to hash these to see
	// they changed, which is when it runs a clean filter.
	old := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	for path, content := range map[string]string{
		filepath.Join(repo, "f.txt"): "c\nb\n",
		filepath.Join(repo, "x.a"):   "w\n",
		filepath.Join(wt, "x.w"):     "w\n",
	} {
		writeFile(t, path, content, 0o644)
		os.Chtimes(path, old, old)
	}
	writeFile(t, filepath.Join(repo, "sub", "s"), "dirty\n", 0o644)

	for _, args := range [][]string{{"status"}, {"diff"}, {"show", "HEAD"}, {"log", "-1"}} {
		exec.Command("git", append([]string{"-C", repo}, args...)...).Run()
	}
	exec.Command("git", "-C", wt, "status").Run()
	live := ran()
	for _, want := range []string{"fsmonitor", "diff-external", "filter-info-attributes", "filter-process", "submodule-fsmonitor", "worktree-filter", "gpg"} {
		if !slices.Contains(live, want) {
			t.Fatalf("plain git ran %v; %q never ran, so this test wouldn't notice it getting through", live, want)
		}
	}

	head, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.TrimSpace(string(head))
	reads := map[string]func() error{
		"Status":       func() error { _, err := Status(repo); return err },
		"UnstagedDiff": func() error { _, err := UnstagedDiff(repo); return err },
		"StagedDiff":   func() error { _, err := StagedDiff(repo); return err },
		"CommitDiff":   func() error { _, err := CommitDiff(repo, hash); return err },
		"Log":          func() error { _, err := Log(repo, 10, ""); return err },
		"CommitInfo":   func() error { _, err := CommitInfo(repo, hash); return err },
		"Remotes":      func() error { _, err := Remotes(repo); return err },
		"Branches":     func() error { _, err := Branches(repo); return err },
		"Tags":         func() error { _, err := Tags(repo); return err },
		"Worktrees":    func() error { _, err := Worktrees(repo); return err },
		// Not --force: the dirty worktree makes git run status inside it
		// first, which is the part under test; it then refuses.
		"RemoveWorktree": func() error { RemoveWorktree(repo, wt, false); return nil },
	}
	for name, read := range reads {
		if err := read(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if got := ran(); len(got) > 0 {
			t.Errorf("%s ran %v", name, got)
		}
	}

	// Still a working view: f.txt and x.a read as changed through the
	// disabled filters, and a submodule at another commit counts - only its
	// own uncommitted edits don't (that would mean running git inside it).
	st, err := Status(repo)
	if err != nil || st.Changed != 2 {
		t.Errorf("Status = %+v, %v; want f.txt and x.a changed", st, err)
	}
	gitT(t, filepath.Join(repo, "sub"), "commit", "-qam", "moved")
	ran()
	if st, err := Status(repo); err != nil || st.Changed != 3 {
		t.Errorf("Status after the submodule moved = %+v, %v; want sub changed too", st, err)
	}
	d, err := UnstagedDiff(repo)
	if err != nil || !strings.Contains(d.Text, "+c") || !strings.Contains(d.Text, "Subproject commit") {
		t.Errorf("UnstagedDiff = %q, %v", d.Text, err)
	}
	if got := ran(); len(got) > 0 {
		t.Errorf("after the submodule moved, reads ran %v", got)
	}
}

func TestFiltersToDisableKeepsOnlyLFS(t *testing.T) {
	isolateGitConfig(t)
	repo := t.TempDir()
	gitT(t, repo, "init", "-q")
	for _, kv := range [][2]string{
		{"filter.lfs.clean", "git-lfs clean -- %f"},
		{"filter.lfs.smudge", "git-lfs smudge -- %f"},
		{"filter.lfs.process", "git-lfs filter-process"},
		{"filter.lfs.required", "true"},
		{"filter.fake-lfs.clean", "git-lfs clean -- %f"},
		{"filter.fake-lfs.process", "sh -c true"},
		{"filter.with.dots.smudge", "cat"},
	} {
		gitT(t, repo, "config", kv[0], kv[1])
	}
	off, err := filtersToDisable(t.Context(), repo)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, kv := range off {
		keys = append(keys, kv[0]+"="+kv[1])
	}
	want := []string{
		"filter.fake-lfs.clean=", "filter.fake-lfs.smudge=", "filter.fake-lfs.process=", "filter.fake-lfs.required=false",
		"filter.with.dots.clean=", "filter.with.dots.smudge=", "filter.with.dots.process=", "filter.with.dots.required=false",
	}
	if !slices.Equal(keys, want) {
		t.Fatalf("filtersToDisable = %v, want %v", keys, want)
	}
}

func TestDiffIsCutAtALine(t *testing.T) {
	isolateGitConfig(t)
	repo := t.TempDir()
	gitT(t, repo, "init", "-q")
	line := strings.Repeat("x", 99) + "\n"
	writeFile(t, filepath.Join(repo, "big"), strings.Repeat(line, 3*maxDiffBytes/len(line)), 0o644)
	gitT(t, repo, "add", "big")
	gitT(t, repo, "commit", "-qm", "big")
	out, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	d, err := CommitDiff(repo, strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatal(err)
	}
	if !d.Truncated || len(d.Text) > maxDiffBytes || !strings.HasSuffix(d.Text, "+"+line) {
		t.Fatalf("CommitDiff: truncated=%v len=%d tail=%q", d.Truncated, len(d.Text), d.Text[max(0, len(d.Text)-20):])
	}
	if _, err := runGit(repo, "show", "--no-color", "HEAD"); err != nil {
		t.Fatalf("a 3 MiB show is under runGit's own cap: %v", err)
	}
}
