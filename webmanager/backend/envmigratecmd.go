package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/qwreey/envmigrate"
)

// envMigrateCmd implements `webmanager --env-migrate` — reconciles a user's
// .env.webmanager (piped in via stdin) against this image's current
// example-env.webmanager (cfg.EnvTemplatePath), writing the reconstructed
// file to stdout and any migration notes to stderr. See
// github.com/qwreey/envmigrate's package doc and
// webmanager/.claude/env-migration-plan.md for the full behavior. Meant to
// be run roughly like:
//
//	cat .env.webmanager >> .env.webmanager.bak && docker compose exec -T code-docker \
//	  /etc/code-docker/webmanager/webmanager --env-migrate < .env.webmanager > .env.webmanager.new \
//	  && mv .env.webmanager.new .env.webmanager
//
// (`-T` because this is non-interactive piped stdin/stdout — same reason
// hashpassword.go's --hash-password needs it when scripted.) NOT the older
// `cat f | tee -a f.bak | ... > f` one-pipeline form: a shell starts every
// stage of a pipeline concurrently, so the final `> f` (O_TRUNC) can land
// before `cat` has opened f — cat then reads nothing, tee appends nothing
// to the backup, and this command dutifully emits a bare template over the
// real file, password hash included. The sequential form above never opens
// the original for writing at all (`<` is read-only, the result lands in
// .new and is mv'd over only after everything succeeded). Always exits 0
// once it has a template to work from, even on a weirdly-shaped input file —
// worst case the template's own structure still comes out, which beats
// producing nothing — with one exception: an *empty* stdin is refused (see
// below), because that is exactly what the race above produces.
func envMigrateCmd(cfg Config) int {
	templateBytes, err := os.ReadFile(cfg.EnvTemplatePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "env-migrate: cannot read template at %s: %v\n", cfg.EnvTemplatePath, err)
		return 1
	}

	oldBytes, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "env-migrate: error reading stdin: %v\n", err)
		return 1
	}
	// A migration of nothing is never what anyone meant: the only way to get
	// here is the truncate-before-read pipeline race described in the doc
	// comment above (or a typo'd path), and emitting the template would turn
	// that into a silently reset .env.webmanager - WEBMANAGER_AUTH_PASSWORD_HASH
	// gone, gate off, no trace. A genuinely new file is `cp example-env.webmanager`,
	// not a migration.
	if len(strings.TrimSpace(string(oldBytes))) == 0 {
		fmt.Fprintln(os.Stderr, "env-migrate: stdin is empty - refusing to write a bare template over an existing file. If the input file really is empty, copy example-env.webmanager instead; if you ran the old `cat f | tee | ... > f` one-liner, the redirection emptied f before cat read it - restore from .env.webmanager.bak and use the sequential form in docs/webmanager-config.md")
		return 1
	}

	res := envmigrate.Migrate(string(oldBytes), string(templateBytes), envMigrateOpts)

	for _, n := range res.Notes {
		fmt.Fprintf(os.Stderr, "env-migrate: %s: %s\n", n.Level, n.Message)
	}

	fmt.Print(res.Output)
	return 0
}
