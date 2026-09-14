package projects

import (
	"errors"
	"testing"
)

func TestValidateCloneURL(t *testing.T) {
	cases := []struct {
		url string
		ok  bool
	}{
		// Network transports.
		{"https://github.com/qwreey/code-docker.git", true},
		{"http://gitea.internal/x/y.git", true},
		{"HTTPS://github.com/qwreey/code-docker", true},
		{"git://git.kernel.org/pub/scm/git/git.git", true},
		{"ssh://git@github.com:22/qwreey/code-docker.git", true},
		{"ssh://git@[::1]/repo.git", true},

		// scp-style.
		{"git@github.com:qwreey/code-docker.git", true},
		{"github.com:qwreey/code-docker.git", true},
		{"user.name@host-1.example.com:~/repo", true},

		// Command-executing remote helpers — the actual finding.
		{"ext::sh -c 'id'", false},
		{"ext::sh", false},
		{"fd::7", false},
		{"transport::address", false},
		{"git@host:path::x", false},

		// Local-filesystem transports.
		{"file:///etc", false},
		{"/etc/passwd", false},
		{"./repo", false},
		{"../repo", false},
		{"~/repo", false},
		// "C:/repo" is deliberately *not* here as a local path: on Linux
		// git reads it as scp-style host "C", which is what this accepts.

		// Other schemes and junk.
		{"ftp://host/repo.git", false},
		{"rsync://host/repo.git", false},
		{"http://", false},
		{"://host/x", false},
		{"", false},
		{"-upload-pack=id", false},
		{"--upload-pack=id", false},
		{"host:path\nmore", false},
		{"host:path\x00", false},
		{"has space:path", false},
		{"host:", false},
		{":path", false},
		{"@host:path", false},
		{"user@:path", false},
		{"plainword", false},
	}

	for _, tc := range cases {
		err := ValidateCloneURL(tc.url)
		if tc.ok && err != nil {
			t.Errorf("ValidateCloneURL(%q) = %v, want accepted", tc.url, err)
		}
		if !tc.ok && !errors.Is(err, ErrInvalidCloneURL) {
			t.Errorf("ValidateCloneURL(%q) = %v, want ErrInvalidCloneURL", tc.url, err)
		}
	}
}
