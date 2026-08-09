package main

import (
	"fmt"
	"io"
	"os"

	"code-docker/envmigrate"
)

// envMigrateOpts parameterizes the shared code-docker/envmigrate package for
// router-manager's own file names - mirrors webmanager/backend/main.go's own
// envMigrateOpts var, same package (code-docker/envmigrate) either way.
var envMigrateOpts = envmigrate.Options{
	VersionKey:       "ROUTER_ENV_VERSION",
	EnvFileName:      ".env.router",
	TemplateFileName: "example-env.router",
}

// envMigrateCmd implements `router-manager --env-migrate` - reconciles a
// user's .env.router (piped in via stdin) against this image's current
// example-env.router (ROUTER_ENV_TEMPLATE_PATH), writing the reconstructed
// file to stdout and any migration notes to stderr. Mirrors webmanager's own
// envmigratecmd.go exactly - see code-docker/envmigrate's package doc for
// the full behavior. Meant to be run roughly like:
//
//	cat .env.router | tee -a .env.router.bak | docker compose exec -T code-docker-router \
//	  router-manager --env-migrate > .env.router
//
// Always exits 0 once it has a template to work from, even on a weirdly-
// shaped input file - worst case the template's own structure still comes
// out, which beats producing nothing.
func envMigrateCmd() int {
	templatePath := os.Getenv("ROUTER_ENV_TEMPLATE_PATH")
	if templatePath == "" {
		templatePath = "/etc/router/example-env.router"
	}

	templateBytes, err := os.ReadFile(templatePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "env-migrate: cannot read template at %s: %v\n", templatePath, err)
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
