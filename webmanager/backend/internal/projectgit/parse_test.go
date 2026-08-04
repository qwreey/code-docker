package projectgit

import "testing"

func TestParseBranchLine(t *testing.T) {
	cases := []struct {
		name                                string
		line                                string
		wantBranch                          string
		wantAhead, wantBehind, wantDiverged int
	}{
		{"no upstream", "## main", "main", 0, 0, 0},
		{"up to date", "## main...origin/main", "main", 0, 0, 0},
		{"ahead only", "## main...origin/main [ahead 1]", "main", 1, 0, 0},
		{"behind only", "## main...origin/main [behind 2]", "main", 0, 2, 0},
		{"ahead and behind", "## main...origin/main [ahead 1, behind 2]", "main", 1, 2, 0},
		{"gone upstream", "## main...origin/main [gone]", "main", 0, 0, 0},
		{"no commits yet", "## No commits yet on main", "main", 0, 0, 0},
		{"detached", "## HEAD (no branch)", "", 0, 0, 0},
		{"not a header line", "M  foo.txt", "", 0, 0, 0},
		{"feature branch with slash", "## feature/x...origin/feature/x [ahead 3]", "feature/x", 3, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			branch, ahead, behind, diverged := parseBranchLine(c.line)
			if branch != c.wantBranch || ahead != c.wantAhead || behind != c.wantBehind || diverged != c.wantDiverged {
				t.Errorf("parseBranchLine(%q) = (%q, %d, %d, %d), want (%q, %d, %d, %d)",
					c.line, branch, ahead, behind, diverged,
					c.wantBranch, c.wantAhead, c.wantBehind, c.wantDiverged)
			}
		})
	}
}

func TestClassifyStatusLine(t *testing.T) {
	cases := []struct {
		name                                                 string
		line                                                 string
		wantConflict, wantUntracked, wantStaged, wantChanged bool
	}{
		{"untracked", "?? newfile.txt", false, true, false, false},
		{"staged add", "A  added.txt", false, false, true, false},
		{"staged modify", "M  staged.txt", false, false, true, false},
		{"unstaged modify", " M unstaged.txt", false, false, false, true},
		{"staged and unstaged (MM)", "MM both.txt", false, false, true, true},
		{"staged then deleted in worktree (MD)", "MD deleted.txt", false, false, true, true},
		{"renamed staged", "R  old.txt -> new.txt", false, false, true, false},
		{"conflict both modified", "UU conflict.txt", true, false, false, false},
		{"conflict added by us", "AU conflict.txt", true, false, false, false},
		{"conflict deleted by them", "DU conflict.txt", true, false, false, false},
		{"conflict added by them", "UA conflict.txt", true, false, false, false},
		{"conflict deleted by us", "UD conflict.txt", true, false, false, false},
		{"conflict both added", "AA conflict.txt", true, false, false, false},
		{"conflict both deleted", "DD conflict.txt", true, false, false, false},
		{"unstaged delete", " D removed.txt", false, false, false, true},
		{"staged delete", "D  removed.txt", false, false, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conflict, untracked, staged, changed := classifyStatusLine(c.line)
			if conflict != c.wantConflict || untracked != c.wantUntracked || staged != c.wantStaged || changed != c.wantChanged {
				t.Errorf("classifyStatusLine(%q) = (conflict=%v, untracked=%v, staged=%v, changed=%v), want (%v, %v, %v, %v)",
					c.line, conflict, untracked, staged, changed,
					c.wantConflict, c.wantUntracked, c.wantStaged, c.wantChanged)
			}
		})
	}
}
