// Package projects scans configured root directories one level deep —
// each immediate subdirectory is a "project" — reporting disk usage,
// reclaimable build/dependency subfolders (node_modules, target, ...),
// a tech-stack badge, and staleness. Read-only: nothing here ever deletes
// anything. Results are cached to disk (ProjectsCachePath) so a full scan
// only runs on an explicit trigger, never on every request.
package projects

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProjectsResponse is the JSON body of GET /api/projects and POST
// /api/projects/scan, and also the on-disk cache file shape.
type ProjectsResponse struct {
	Roots         []string      `json:"roots"`
	Scanning      bool          `json:"scanning"`
	ScannedAt     *string       `json:"scannedAt"`
	Projects      []ProjectInfo `json:"projects"`
	CodeServerURL string        `json:"codeServerUrl"`
}

// ProjectInfo is one scanned project (one immediate subdirectory of a root).
type ProjectInfo struct {
	Root                 string             `json:"root"`
	Name                 string             `json:"name"`
	Path                 string             `json:"path"`
	TotalSizeBytes       int64              `json:"totalSizeBytes"`
	ReclaimableSizeBytes int64              `json:"reclaimableSizeBytes"`
	Reclaimable          []ReclaimableEntry `json:"reclaimable"`
	LastModified         string             `json:"lastModified"`
	Stale                bool               `json:"stale"`
	TechStack            []string           `json:"techStack"`
	ScannedAt            string             `json:"scannedAt"`
}

// ReclaimableEntry is one matched reclaimable subtree (node_modules, target,
// ...) found anywhere inside a project.
type ReclaimableEntry struct {
	Pattern   string `json:"pattern"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

var (
	ErrUnknownProject = errors.New("unknown project path")
	ErrProjectGone    = errors.New("project no longer exists")
)

// Scanner owns the scan roots, the on-disk cache, and the "one full scan at
// a time" coordination. All exported methods are safe for concurrent use.
type Scanner struct {
	paths         []string
	cachePath     string
	patternsPath  string
	oldDays       int
	codeServerURL string

	// staleAfter is accepted from config (WEBMANAGER_PROJECTS_STALE_AFTER)
	// but per-project auto-refresh against it is a frontend-side decision
	// (expand a project's detail view, compare its scannedAt, call
	// POST /api/projects/rescan if stale) — nothing in this package or the
	// HTTP API enforces it server-side.
	staleAfter time.Duration

	mu       sync.Mutex
	scanning bool
	cache    ProjectsResponse
}

// NewScanner builds a Scanner from raw config strings. staleAfterStr and
// oldDaysStr are parsed here (not in config.go) so a bad override degrades
// to a sane default with a log line instead of failing startup.
func NewScanner(pathsEnv, cachePath, patternsPath, staleAfterStr, oldDaysStr, codeServerURL string) *Scanner {
	staleAfter, err := time.ParseDuration(staleAfterStr)
	if err != nil {
		log.Printf("projects: invalid stale-after %q, using 1h: %v", staleAfterStr, err)
		staleAfter = time.Hour
	}
	oldDays, err := strconv.Atoi(oldDaysStr)
	if err != nil {
		log.Printf("projects: invalid old-days %q, using 90: %v", oldDaysStr, err)
		oldDays = 90
	}

	s := &Scanner{
		paths:         cleanPaths(pathsEnv),
		cachePath:     cachePath,
		patternsPath:  patternsPath,
		staleAfter:    staleAfter,
		oldDays:       oldDays,
		codeServerURL: codeServerURL,
	}

	cached, err := loadCache(cachePath)
	if err != nil {
		log.Printf("projects: loading cache %s: %v", cachePath, err)
	}
	s.cache = cached
	return s
}

// cleanPaths splits a PATH-style colon-separated list of roots, dropping
// empty segments (trailing/leading/doubled colons).
func cleanPaths(raw string) []string {
	result := []string{}
	for _, p := range strings.Split(raw, ":") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		result = append(result, filepath.Clean(p))
	}
	return result
}

// Snapshot returns the current cached response plus live scanning state.
// Roots always reflects the configured paths (not whatever the cache last
// saw) so a never-scanned server still reports its roots. The Projects
// slice is copied so a concurrent scan replacing s.cache afterward can't
// race with the caller (e.g. JSON-encoding the returned value).
func (s *Scanner) Snapshot() ProjectsResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	projects := make([]ProjectInfo, len(s.cache.Projects))
	copy(projects, s.cache.Projects)
	return ProjectsResponse{
		Roots:         s.paths,
		Scanning:      s.scanning,
		ScannedAt:     s.cache.ScannedAt,
		Projects:      projects,
		CodeServerURL: s.codeServerURL,
	}
}

// TriggerScan starts a full rescan in the background unless one is already
// running, in which case it's a no-op — the in-flight scan will update the
// cache when it finishes. The scanning flag flips synchronously before this
// returns, so a Snapshot() call immediately after always reflects it.
func (s *Scanner) TriggerScan() {
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return
	}
	s.scanning = true
	s.mu.Unlock()
	go s.runScan()
}

type projectRef struct {
	root string
	path string
}

func discoverProjects(roots []string) []projectRef {
	var refs []projectRef
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			refs = append(refs, projectRef{root: root, path: filepath.Join(root, e.Name())})
		}
	}
	return refs
}

func (s *Scanner) runScan() {
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
	}()

	patterns := loadPatterns(s.patternsPath)
	refs := discoverProjects(s.paths)

	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	jobs := make(chan projectRef)
	var wg sync.WaitGroup
	var resultsMu sync.Mutex
	results := make([]ProjectInfo, 0, len(refs))

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ref := range jobs {
				info := scanProject(ref.root, ref.path, patterns, s.oldDays)
				resultsMu.Lock()
				results = append(results, info)
				resultsMu.Unlock()
			}
		}()
	}
	for _, ref := range refs {
		jobs <- ref
	}
	close(jobs)
	wg.Wait()

	sort.Slice(results, func(i, j int) bool { return results[i].Path < results[j].Path })

	now := time.Now().UTC().Format(time.RFC3339)
	resp := ProjectsResponse{
		Roots:         s.paths,
		Scanning:      false,
		ScannedAt:     &now,
		Projects:      results,
		CodeServerURL: s.codeServerURL,
	}

	s.mu.Lock()
	s.cache = resp
	err := saveCache(s.cachePath, resp)
	s.mu.Unlock()
	if err != nil {
		log.Printf("projects: saving cache: %v", err)
	}
}

// IsKnownPath reports whether path exactly matches an already-known
// project's Path — the same validation convention RescanOne uses (exact
// match against the cache, not a prefix/contains check). Other features
// (e.g. internal/mise) that accept a `path` query/body parameter reuse this
// so an arbitrary filesystem path can never be passed to a shell-out.
func (s *Scanner) IsKnownPath(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.cache.Projects {
		if p.Path == path {
			return true
		}
	}
	return false
}

// RescanOne rescans exactly one already-known project (path must exactly
// match an existing cached project's Path — this is the security-relevant
// validation, not a prefix/contains check) and updates it in the cache. If
// the directory no longer exists on disk, it's removed from the cache and
// ErrProjectGone is returned.
func (s *Scanner) RescanOne(path string) (ProjectInfo, error) {
	s.mu.Lock()
	idx := -1
	var root string
	for i, p := range s.cache.Projects {
		if p.Path == path {
			idx = i
			root = p.Root
			break
		}
	}
	s.mu.Unlock()
	if idx == -1 {
		return ProjectInfo{}, ErrUnknownProject
	}

	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			s.mu.Lock()
			for i, p := range s.cache.Projects {
				if p.Path == path {
					s.cache.Projects = append(s.cache.Projects[:i], s.cache.Projects[i+1:]...)
					break
				}
			}
			if saveErr := saveCache(s.cachePath, s.cache); saveErr != nil {
				log.Printf("projects: saving cache: %v", saveErr)
			}
			s.mu.Unlock()
			return ProjectInfo{}, ErrProjectGone
		}
		return ProjectInfo{}, err
	}

	patterns := loadPatterns(s.patternsPath)
	info := scanProject(root, path, patterns, s.oldDays)

	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.cache.Projects {
		if p.Path == path {
			s.cache.Projects[i] = info
			break
		}
	}
	if err := saveCache(s.cachePath, s.cache); err != nil {
		return ProjectInfo{}, err
	}
	return info, nil
}
