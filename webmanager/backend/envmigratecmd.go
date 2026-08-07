package main

import (
	"fmt"
	"io"
	"os"

	"code-docker/envmigrate"
)

// envMigrateCmd implements `webmanager --env-migrate` — reconciles a user's
// .env.webmanager (piped in via stdin) against this image's current
// example-env.webmanager (cfg.EnvTemplatePath), writing the reconstructed
// file to stdout and any migration notes to stderr. See
// code-docker/envmigrate's package doc and
// webmanager/.claude/env-migration-plan.md for the full behavior. Meant to
// be run roughly like:
//
//	cp .env.webmanager .env.webmanager.bak
//	cat .env.webmanager | docker compose exec -T code-docker \
//	  /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager
//
// (`-T` because this is non-interactive piped stdin/stdout — same reason
// hashpassword.go's --hash-password needs it when scripted.) Always exits 0
// once it has a template to work from, even on a weirdly-shaped input file —
// worst case the template's own structure still comes out, which beats
// producing nothing.
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

	res := envmigrate.Migrate(string(oldBytes), string(templateBytes), envMigrateOpts)

	for _, n := range res.Notes {
		fmt.Fprintf(os.Stderr, "env-migrate: %s: %s\n", n.Level, n.Message)
	}

	fmt.Print(res.Output)
	return 0
}
