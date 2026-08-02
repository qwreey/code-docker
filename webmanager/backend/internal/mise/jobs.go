package mise

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// jobTTL/maxJobs bound how long finished jobs stay in memory. This is a
// progress view, not a permanent record (see mise-plan.md's streaming
// design), so simple bounded cleanup on every new job is enough — no
// background sweeper goroutine needed.
const (
	jobTTL  = 10 * time.Minute
	maxJobs = 50
)

// job is one background command run (or short sequence of runs — see
// Start's variadic argSets, used by the DELETE handler's optional
// "uninstall then also remove from config" case). All fields are guarded
// by JobStore.mu, not a per-job lock — this package's job volume/size is
// small enough that one store-wide mutex is simpler and plenty fast.
type job struct {
	running   bool
	exitCode  *int
	lines     []string
	startedAt time.Time
}

// JobStatus is the JSON-facing snapshot of a job's state, returned by
// JobStore.Status.
type JobStatus struct {
	Running  bool     `json:"running"`
	ExitCode *int     `json:"exitCode"`
	Lines    []string `json:"lines"`
}

// JobStore tracks background mise command runs so POST /api/mise/tools and
// DELETE /api/mise/tools can return a {jobId} immediately while the actual
// install/uninstall keeps running, and the frontend polls
// GET /api/mise/jobs/:id for progress (mise-plan.md's polling-based
// streaming design — no PTY/WebSocket).
type JobStore struct {
	mu   sync.Mutex
	jobs map[string]*job
}

// NewJobStore returns an empty JobStore, ready to use.
func NewJobStore() *JobStore {
	return &JobStore{jobs: make(map[string]*job)}
}

// pruneLocked removes finished jobs older than jobTTL, then — if the store
// is still above maxJobs — drops the oldest finished jobs until it's back
// under the cap. Running jobs are never pruned. Caller must hold s.mu.
func (s *JobStore) pruneLocked() {
	now := time.Now()
	for id, j := range s.jobs {
		if !j.running && now.Sub(j.startedAt) > jobTTL {
			delete(s.jobs, id)
		}
	}

	if len(s.jobs) <= maxJobs {
		return
	}

	type entry struct {
		id        string
		startedAt time.Time
	}
	finished := make([]entry, 0, len(s.jobs))
	for id, j := range s.jobs {
		if !j.running {
			finished = append(finished, entry{id, j.startedAt})
		}
	}
	sort.Slice(finished, func(i, k int) bool { return finished[i].startedAt.Before(finished[k].startedAt) })
	for _, e := range finished {
		if len(s.jobs) <= maxJobs {
			break
		}
		delete(s.jobs, e.id)
	}
}

func newJobID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Start runs binPath once per entry of argSets, in order, as a single
// background job — used with one argSet for a plain install (`mise use`)
// or uninstall, and two for DELETE's optional "uninstall, then also
// `mise use --remove` to drop the config entry" case. It returns the new
// job's ID immediately; the command(s) keep running in the background after
// Start returns. Deliberately no context.WithTimeout here (unlike
// ListTools/GetEnv) — installs can take real download time, and the
// job/polling model itself is what removes the need for a timeout (see
// mise-plan.md's "스트리밍 방식" section).
func (s *JobStore) Start(binPath string, argSets ...[]string) string {
	id := newJobID()
	j := &job{running: true, lines: []string{}, startedAt: time.Now()}

	s.mu.Lock()
	s.pruneLocked()
	s.jobs[id] = j
	s.mu.Unlock()

	appendLine := func(line string) {
		s.mu.Lock()
		j.lines = append(j.lines, line)
		s.mu.Unlock()
	}

	go func() {
		lastCode := 0
		for i, args := range argSets {
			if i > 0 {
				appendLine("--- " + binPath + " " + strings.Join(args, " ") + " ---")
			}
			lastCode = runOne(context.Background(), binPath, args, appendLine)
		}

		s.mu.Lock()
		j.running = false
		code := lastCode
		j.exitCode = &code
		s.mu.Unlock()
	}()

	return id
}

// runOne runs one command to completion, streaming its stdout+stderr into
// appendLine line-by-line as output arrives (not buffered until exit) —
// doc-verified that mise's own install/uninstall progress lines actually
// go to stderr, not stdout as first assumed, so both streams are scanned
// concurrently and merged into the same job log. Returns the process's
// exit code (0 on success, -1 if the process couldn't even be started).
func runOne(ctx context.Context, binPath string, args []string, appendLine func(string)) int {
	cmd := exec.CommandContext(ctx, binPath, args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		appendLine(err.Error())
		return -1
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		appendLine(err.Error())
		return -1
	}

	if err := cmd.Start(); err != nil {
		appendLine(err.Error())
		return -1
	}

	var wg sync.WaitGroup
	wg.Add(2)
	scan := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for scanner.Scan() {
			appendLine(scanner.Text())
		}
	}
	go scan(stdout)
	go scan(stderr)
	wg.Wait()

	err = cmd.Wait()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	appendLine(err.Error())
	return -1
}

// Status returns a snapshot of job id's current state. ok is false if no
// such job exists (never existed, or already pruned by TTL/cap).
func (s *JobStore) Status(id string) (JobStatus, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, ok := s.jobs[id]
	if !ok {
		return JobStatus{}, false
	}

	lines := make([]string, len(j.lines))
	copy(lines, j.lines)
	return JobStatus{Running: j.running, ExitCode: j.exitCode, Lines: lines}, true
}
