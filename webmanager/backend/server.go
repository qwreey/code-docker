package main

import (
	"encoding/json"
	"net/http"

	"webmanager/internal/authgate"
	"webmanager/internal/cgroup"
	"webmanager/internal/claudecode"
	"webmanager/internal/diskusage"
	"webmanager/internal/mise"
	"webmanager/internal/procinfo"
	"webmanager/internal/projects"
	"webmanager/internal/supervisor"
	"webmanager/internal/tailscale"
	"webmanager/internal/termsession"
)

type Server struct {
	cfg             Config
	sup             *supervisor.Client
	procSampler     *procinfo.Sampler
	cgroupSampler   *cgroup.Sampler
	resourceHistory *cgroup.HistorySampler
	// hostCPUSampler/hostSensors back the live GET /api/system/resources
	// endpoint's host-wide per-core CPU/clock/thermal sections — separate
	// instances from resourceHistory's own internal HostCPUSampler for the
	// same reason cgroupSampler and resourceHistory's cpu Sampler are kept
	// apart (see cgroup.HistorySampler's doc comment).
	hostCPUSampler *cgroup.HostCPUSampler
	hostSensors    *cgroup.HostSensors
	projectScanner *projects.Scanner
	miseJobs       *mise.JobStore
	loginMgr       *claudecode.LoginManager
	tailscaleLogin *tailscale.LoginManager
	diskUsage      *diskusage.Analyzer
	termSessions   *termsession.Registry
	gate           *authgate.Gate

	// envTemplateVersion is cfg.EnvTemplatePath's WEBMANAGER_ENV_VERSION at
	// startup ("" if the template was unreadable) — see
	// webmanager/.claude/env-migration-plan.md. Computed once in main(),
	// not re-read per request: it only changes on a container rebuild.
	envTemplateVersion string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// maxRequestBodyBytes caps every request body this API accepts. 1 MiB is
// generous for every legitimate payload here (the largest is something like
// an SSH public key paste, nowhere near that size) — this is defense-in-
// depth against an unbounded read, not a real usability constraint.
const maxRequestBodyBytes = 1 << 20

// limitRequestBody wraps every request's body in http.MaxBytesReader so a
// json.Decoder reading past the cap gets a clean error (which every handler
// here already maps to 400 "invalid request body") instead of reading an
// unbounded amount of attacker-controlled data.
//
// The file upload route is exempt from this blanket 1 MiB cap — it's a
// streaming multipart upload that can legitimately be gigabytes. It applies
// its own, much larger cap (WEBMANAGER_FILES_MAX_UPLOAD_BYTES) directly via
// http.MaxBytesReader in handleFilesUpload before reading the body, so it's
// still bounded — just not at this middleware's small default.
func limitRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/files/upload" {
			next.ServeHTTP(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		next.ServeHTTP(w, r)
	})
}
