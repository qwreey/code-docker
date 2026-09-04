package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"webmanager/internal/authgate"
	"webmanager/internal/cgroup"
	"webmanager/internal/claudecode"
	"webmanager/internal/diskusage"
	"webmanager/internal/mise"
	"webmanager/internal/procinfo"
	"webmanager/internal/projects"
	"webmanager/internal/sessionheartbeat"
	"webmanager/internal/supervisor"
	"webmanager/internal/termsession"
	"webmanager/internal/webdavshare"
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
	// projectJobs backs POST /api/projects/clone's background `git clone` —
	// a separate *mise.JobStore instance from miseJobs (same reusable type,
	// see internal/mise/jobs.go's doc comment: nothing about it is actually
	// mise-specific except the package name) so a clone job's id/TTL/cap
	// never intermixes with mise's own install/uninstall jobs, and its
	// polling route can live under /api/projects/... instead of the
	// mise-specific /api/mise/jobs/{id} path.
	projectJobs         *mise.JobStore
	loginMgr            *claudecode.LoginManager
	interactiveLoginMgr *claudecode.InteractiveLoginManager
	diskUsage           *diskusage.Analyzer
	termSessions        *termsession.Registry
	sessionHeartbeats   *sessionheartbeat.Store
	gate                *authgate.Gate
	// webdav is both the File share tab's settings store and the handler
	// serving /webdav/ itself — it holds the live config, so a change made
	// in the tab takes effect on the next request with no restart.
	webdav *webdavshare.Service

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
// webdavRouter dispatches the WebDAV share ahead of everything else,
// including limitRequestBody — a PUT there is a file upload of arbitrary
// size, streamed straight to disk rather than held in memory, and a WebDAV
// client has no way to be told about a byte cap other than a failed
// transfer.
//
// It is a wrapper rather than two more mux patterns because net/http's
// ServeMux refuses the combination outright: a method-less "/webdav/"
// alongside the "GET /" static handler is rejected at registration as
// ambiguous ("GET / matches fewer methods than /webdav/, but has a more
// general path pattern"), and it panics at startup rather than at build
// time. Registering per method instead would mean enumerating
// PROPFIND/PROPPATCH/MKCOL/MOVE/COPY/LOCK/UNLOCK/OPTIONS and keeping that
// list in sync with x/net/webdav's own.
//
// The bare prefix is matched too, not just the subtree: a client pointed at
// ".../webdav" issues a PROPFIND on exactly that path, and a redirect isn't
// reliably followed for non-GET methods.
func webdavRouter(share http.Handler, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == webdavshare.URLPrefix || strings.HasPrefix(r.URL.Path, webdavshare.URLPrefix+"/") {
			share.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

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
