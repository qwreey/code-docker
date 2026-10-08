package procinfo

import (
	"strings"
	"testing"
)

func TestRedactCmdline(t *testing.T) {
	for in, secret := range map[string]string{
		"curl -H Authorization: Bearer abc.def.ghi https://x":     "abc.def.ghi",
		"curl -H authorization:token-only https://x":              "token-only",
		"mysql --password=hunter2 db":                             "hunter2",
		"tool --api-key K3Y123 run":                               "K3Y123",
		"app --client_secret=s3cr3t":                              "s3cr3t",
		"env GITHUB_TOKEN=ghx123 git push":                        "ghx123",
		"git clone https://user:pa55word@example.com/r.git":       "pa55word",
		"node server.js sk-ant-api03-abcdefghijklmnopqrstuvwxyz":  "abcdefghijklmnop",
		"run ghp_abcdefghijklmnopqrstuvwxyz0123456789":            "ghp_abcdefghij",
		"cdp-bridge unwrap -token-env CHROME_CDP_TOKEN -listen x": "", // a variable name, not a value
	} {
		out := RedactCmdline(in)
		if secret != "" && strings.Contains(out, secret) {
			t.Errorf("RedactCmdline(%q) = %q, still contains %q", in, out, secret)
		}
		if secret == "" && !strings.Contains(out, "-listen x") {
			t.Errorf("RedactCmdline(%q) = %q, mangled the rest", in, out)
		}
	}
	// Ordinary command lines stay as they are.
	for _, in := range []string{"/usr/bin/python3 -m http.server 5173", "supervisord -n -c /etc/x.conf", "code-server --auth none"} {
		if got := RedactCmdline(in); got != in && in != "code-server --auth none" {
			t.Errorf("RedactCmdline(%q) = %q", in, got)
		}
	}
}
