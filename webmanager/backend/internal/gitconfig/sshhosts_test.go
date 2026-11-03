package gitconfig

import "testing"

func TestValidateAddSSHHostInput(t *testing.T) {
	ok := []struct{ host, hostname, user string }{
		{"gh", "github.com", "git"},
		{"lan", "192.168.0.10", "me"},
		{"v6", "fe80::1%eth0", "me"},
		{"tok", "%h.example.com", "%r"},
		{"ad", "box.corp", "me@corp.example"},
	}
	for _, c := range ok {
		if err := validateAddSSHHostInput(c.host, c.hostname, c.user); err != nil {
			t.Errorf("validateAddSSHHostInput(%q, %q, %q) = %v, want nil", c.host, c.hostname, c.user, err)
		}
	}
	bad := []struct{ host, hostname, user string }{
		{"", "github.com", "git"},
		{"../x", "github.com", "git"},
		{"gh", "", "git"},
		{"gh", "github.com", ""},
		{"gh", "github.com\nUser x", "git"},
		{"gh", "github.com other", "git"},
		{"gh", "github.com#x", "git"},
		{"gh", "github.com", "git #x"},
		{"gh", "github.com", "\"git\""},
		{"gh", "github.com", "git\tx"},
	}
	for _, c := range bad {
		if err := validateAddSSHHostInput(c.host, c.hostname, c.user); err == nil {
			t.Errorf("validateAddSSHHostInput(%q, %q, %q) = nil, want ErrInvalidHost", c.host, c.hostname, c.user)
		}
	}
}
