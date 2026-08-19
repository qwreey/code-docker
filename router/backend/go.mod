module router

go 1.25.0

require (
	github.com/qwreey/envmigrate v0.0.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/term v0.45.0 // indirect
)

// router/Dockerfile's build context is router/ only (see router/CLAUDE.md -
// deliberately isolated from the repo root), so unlike webmanager/backend
// this can't just COPY the repo-root envmigrate/ module directly - `go mod
// vendor` (see repo-root vendor-envmigrate.sh) materializes it into
// router/backend/vendor/, which IS inside router's own build context.
// This replace directive still matters for local `go build`/`go test`/`go
// mod vendor` on a normal checkout - only the Docker build ignores it in
// favor of vendor/.
replace github.com/qwreey/envmigrate => ../../envmigrate
