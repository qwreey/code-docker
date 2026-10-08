package procinfo

import "regexp"

// A command line is often where a secret ends up: `curl -H 'Authorization:
// Bearer ...'`, `--password=...`, `TOKEN=... cmd`, a URL with a password in
// it. The process list is readable without the password gate, so behind a
// configured, locked gate those parts are masked. The patterns aim at the
// common shapes; they can't promise to catch everything.
var cmdlineSecrets = []struct {
	re   *regexp.Regexp
	keep string // replacement; $1 keeps the part before the secret
}{
	// Authorization/Proxy-Authorization header values, with or without a scheme.
	{regexp.MustCompile(`(?i)((?:proxy-)?authorization:\s*(?:bearer|basic|token|digest)?\s*)\S+`), "${1}***"},
	// --password=x, --api-key x, -auth-token=x, --client_secret x ...
	{regexp.MustCompile(`(?i)(-{1,2}[\w.-]*(?:passw(?:or)?d|pass|token|secret|api[-_]?key|apikey|credential|auth)[\w.-]*(?:=|\s+))[^\s-][^\s]*`), "${1}***"},
	// FOO_TOKEN=x, DB_PASSWORD=x as env assignments in the command line.
	{regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|CREDENTIALS?)[A-Z0-9_]*=)\S+`), "${1}***"},
	// scheme://user:password@host
	{regexp.MustCompile(`(://[^\s:/@]+:)[^\s@/]+@`), "${1}***@"},
	// Well-known token shapes wherever they appear.
	{regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b`), "***"},
}

// RedactCmdline masks what looks like a credential in a command line.
func RedactCmdline(cmdline string) string {
	for _, s := range cmdlineSecrets {
		cmdline = s.re.ReplaceAllString(cmdline, s.keep)
	}
	return cmdline
}
